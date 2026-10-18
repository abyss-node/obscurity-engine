// Deezer fan-count veto for South Asian candidates that Last.fm undercounts.
//
// Why: Last.fm only sees scrobbles, and South Asian mainstream audiences listen
// on YouTube, JioSaavn, Gaana and Wynk, none of which scrobble. A Punjabi star
// with 19.8K Last.fm listeners passes the 25K "obscure" ceiling and dominates an
// Indian user's recommendations. Deezer's public artist search reports `nb_fan`,
// a count that is not scrobble-based, and a fan count at or above
// `DEEZER_VETO_FANS` marks the artist as mainstream.
//
// Scope is mandatory. Unscoped, the same rule would veto real niche metal
// (Mortal Decay, Harm's Way) that happens to have a few thousand Deezer fans.
// The veto only ever looks at candidates whose first five Last.fm tags are in
// `SCOPE_TAGS`.
//
// Failure policy is fail-open everywhere: no match, a timeout, a 429, a quota
// error, an exhausted budget and a kill switch all KEEP the candidate. A missed
// veto is a cosmetic miss; hiding an obscure artist is the product failing.
//
// API: `GET {base}/search/artist?q=<name>&limit=3`, accepted only on an exact
// normalized-name match. Deezer allows 50 requests per 5 seconds per IP and
// reports quota exhaustion as HTTP 200 with `{"error":{"code":4,...}}`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use futures::stream::{FuturesUnordered, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::cache::CacheStore;
use crate::models::DiscoveryResponseItem;
use crate::utils::normalize_artist_name;

const DEFAULT_BASE: &str = "https://api.deezer.com";
/// Fan count at or above which an in-scope artist is treated as mainstream.
/// Spike (88 South Asian-tagged artists): 2000 vetoed 25 mainstream names and
/// kept 63 indie ones. Overridable with `DEEZER_VETO_FANS`.
pub const DEFAULT_VETO_FANS: u64 = 2000;
const CONCURRENCY: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
/// Total wall-clock the veto stage may add to one discovery.
pub const VETO_BUDGET: Duration = Duration::from_secs(4);
/// How many in-scope candidates (in rank order) are checked per request.
const MAX_CHECKED: usize = 60;
/// Self-imposed ceiling, under Deezer's 50 per 5 s per IP, shared by all requests.
const WINDOW: Duration = Duration::from_secs(5);
const WINDOW_MAX_CALLS: usize = 40;
const FOUND_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const UNKNOWN_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
const QUOTA_COOLDOWN: Duration = Duration::from_secs(10);
const DEFAULT_429_COOLDOWN: Duration = Duration::from_secs(30);

/// Last.fm tags (compared lowercase, whole-tag, hyphens and underscores read as
/// spaces) that put a candidate in scope. Only the first five tags count.
///
/// Included: language, nationality and film-industry tags whose audiences live
/// on non-scrobbling platforms (Punjabi, Hindi, Bollywood, Pakistani, Bengali,
/// Tamil, Telugu and so on), plus the devotional/folk forms that sit in the same
/// mainstream ecosystem (sufi, qawwali, ghazal).
///
/// Left out on purpose: carnatic and hindustani classical, which are niche
/// scenes with a different audience; any genre tag on its own (metal, rock,
/// hip hop), which would pull in Western niche acts.
pub const SCOPE_TAGS: &[&str] = &[
    "punjabi", "punjabi pop", "bhangra", "bollywood", "filmi", "hindi", "hindie",
    "indian", "india", "indian pop", "desi", "desi hip hop",
    "pakistani", "pakistan", "urdu", "bengali", "bangladeshi",
    "tamil", "telugu", "kannada", "malayalam", "marathi", "gujarati",
    "kollywood", "tollywood", "sufi", "qawwali", "ghazal",
];

const TAG_WINDOW: usize = 5;

fn norm_tag(tag: &str) -> String {
    tag.to_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether any of the first five tags is a South Asian scope tag.
pub fn in_scope<S: AsRef<str>>(tags: &[S]) -> bool {
    tags.iter()
        .take(TAG_WINDOW)
        .any(|t| SCOPE_TAGS.contains(&norm_tag(t.as_ref()).as_str()))
}

/// Cached lookup result. `fans: None` is a successful search with no exact
/// name match, cached for a shorter time than a hit.
#[derive(Serialize, Deserialize)]
struct CachedFans {
    fans: Option<u64>,
}

fn cache_key(norm_name: &str) -> String {
    format!("deezer_fans:{norm_name}")
}

pub struct DeezerClient {
    http: Client,
    base: String,
    veto_fans: u64,
    sem: Semaphore,
    calls: StdMutex<VecDeque<Instant>>,
    cooldown_until: StdMutex<Option<Instant>>,
    last_failed: AtomicBool,
}

/// What `apply_veto` needs from the application state.
#[derive(Clone, Copy)]
pub struct VetoConfig<'a> {
    pub deezer: &'a DeezerClient,
    pub cache: &'a CacheStore,
}

impl DeezerClient {
    /// `None` when `DEEZER_VETO=off` (the kill switch). Otherwise a client whose
    /// base URL (`DEEZER_API_BASE`) and threshold (`DEEZER_VETO_FANS`) come from
    /// the environment.
    pub fn from_env() -> Option<Self> {
        Self::from_settings(
            std::env::var("DEEZER_VETO").ok().as_deref(),
            std::env::var("DEEZER_VETO_FANS").ok().as_deref(),
            std::env::var("DEEZER_API_BASE").ok().as_deref(),
        )
    }

    pub fn from_settings(veto: Option<&str>, fans: Option<&str>, base: Option<&str>) -> Option<Self> {
        if veto.is_some_and(|v| v.trim().eq_ignore_ascii_case("off")) {
            return None;
        }
        let veto_fans = fans
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_VETO_FANS);
        let base = base.filter(|b| !b.is_empty()).unwrap_or(DEFAULT_BASE);
        Some(Self::new(base, veto_fans))
    }

    pub fn new(base: &str, veto_fans: u64) -> Self {
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            veto_fans,
            sem: Semaphore::new(CONCURRENCY),
            calls: StdMutex::new(VecDeque::new()),
            cooldown_until: StdMutex::new(None),
            last_failed: AtomicBool::new(false),
        }
    }

    pub fn veto_fans(&self) -> u64 {
        self.veto_fans
    }

    /// True while a cooldown is active or the last live call failed. Reads
    /// local state only, so `/api/status` never triggers a Deezer request.
    pub fn degraded(&self) -> bool {
        self.in_cooldown() || self.last_failed.load(Ordering::Relaxed)
    }

    fn in_cooldown(&self) -> bool {
        let mut g = self.cooldown_until.lock().unwrap_or_else(|e| e.into_inner());
        match *g {
            Some(t) if t > Instant::now() => true,
            Some(_) => {
                *g = None;
                false
            }
            None => false,
        }
    }

    fn start_cooldown(&self, d: Duration) {
        *self.cooldown_until.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + d);
    }

    /// Reserve one call in the sliding window. False means the window is full
    /// and the caller must treat the lookup as unknown rather than wait.
    fn take_slot(&self) -> bool {
        let mut q = self.calls.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        while q.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            q.pop_front();
        }
        if q.len() >= WINDOW_MAX_CALLS {
            return false;
        }
        q.push_back(now);
        true
    }

    /// Fan count for an artist, or `None` when unknown for any reason.
    /// Cache hits make no network call; failures are never cached.
    pub async fn fan_count(&self, cache: &CacheStore, name: &str) -> Option<u64> {
        let norm = normalize_artist_name(name);
        if norm.is_empty() {
            return None;
        }
        let key = cache_key(&norm);
        if let Some(c) = cache.get_json::<CachedFans>(&key).await {
            return c.fans;
        }
        if self.in_cooldown() {
            return None;
        }
        let _permit = self.sem.acquire().await.ok()?;
        // Re-check after waiting for a permit: a sibling may have hit a limit.
        if self.in_cooldown() || !self.take_slot() {
            return None;
        }
        match self.search(name, &norm).await {
            Some(fans) => {
                let ttl = if fans.is_some() { FOUND_TTL } else { UNKNOWN_TTL };
                cache.put_json(&key, &CachedFans { fans }, ttl).await;
                self.last_failed.store(false, Ordering::Relaxed);
                fans
            }
            None => None,
        }
    }

    /// `Some(Some(n))` exact match, `Some(None)` searched and no exact match,
    /// `None` the call failed (nothing to cache).
    async fn search(&self, name: &str, norm: &str) -> Option<Option<u64>> {
        let resp = match self
            .http
            .get(format!("{}/search/artist", self.base))
            .query(&[("q", name), ("limit", "3")])
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                self.last_failed.store(true, Ordering::Relaxed);
                return None;
            }
        };
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let secs = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(DEFAULT_429_COOLDOWN);
            self.start_cooldown(secs.max(Duration::from_secs(1)));
            self.last_failed.store(true, Ordering::Relaxed);
            eprintln!("Deezer 429: cooling down {}s, veto fails open meanwhile", secs.as_secs());
            return None;
        }
        let body = match resp.text().await {
            Ok(b) if status.is_success() => b,
            _ => {
                self.last_failed.store(true, Ordering::Relaxed);
                return None;
            }
        };
        let v: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => {
                self.last_failed.store(true, Ordering::Relaxed);
                return None;
            }
        };
        if let Some(err) = v.get("error") {
            let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            if code == 4 {
                self.start_cooldown(QUOTA_COOLDOWN);
                eprintln!("Deezer quota error (code 4): cooling down {}s", QUOTA_COOLDOWN.as_secs());
            }
            self.last_failed.store(true, Ordering::Relaxed);
            return None;
        }
        let fans = v
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|items| {
                items.iter().find(|it| {
                    it.get("name")
                        .and_then(|n| n.as_str())
                        .is_some_and(|n| normalize_artist_name(n) == norm)
                })
            })
            .and_then(|it| it.get("nb_fan").and_then(|f| f.as_u64()));
        Some(fans)
    }
}

/// Drop in-scope candidates whose Deezer fan count is at or above the veto
/// threshold. Runs on the ranked list before `post_process` truncates, so the
/// list backfills from the next-ranked candidates.
pub async fn apply_veto(
    scored: Vec<DiscoveryResponseItem>,
    cfg: Option<VetoConfig<'_>>,
) -> Vec<DiscoveryResponseItem> {
    apply_veto_with_budget(scored, cfg, VETO_BUDGET).await
}

pub async fn apply_veto_with_budget(
    scored: Vec<DiscoveryResponseItem>,
    cfg: Option<VetoConfig<'_>>,
    budget: Duration,
) -> Vec<DiscoveryResponseItem> {
    let Some(cfg) = cfg else { return scored };
    let targets: Vec<String> = scored
        .iter()
        .filter(|a| in_scope(&a.top_tags))
        .take(MAX_CHECKED)
        .map(|a| a.name.clone())
        .collect();
    if targets.is_empty() {
        return scored;
    }

    let deadline = tokio::time::Instant::now() + budget;
    let mut futs = FuturesUnordered::new();
    for name in &targets {
        futs.push(async move { (name.as_str(), cfg.deezer.fan_count(cfg.cache, name).await) });
    }
    let mut fans: HashMap<String, u64> = HashMap::new();
    let mut resolved = 0usize;
    while let Ok(Some((name, f))) = tokio::time::timeout_at(deadline, futs.next()).await {
        resolved += 1;
        if let Some(f) = f {
            fans.insert(name.to_string(), f);
        }
    }
    drop(futs);

    let threshold = cfg.deezer.veto_fans();
    let vetoed: HashSet<&str> = fans
        .iter()
        .filter(|(_, f)| **f >= threshold)
        .map(|(n, _)| n.as_str())
        .collect();
    let unknown = targets.len() - fans.len();
    println!(
        "DEEZER: checked {} in-scope, vetoed {}, unknown {} ({} unresolved in budget)",
        targets.len(),
        vetoed.len(),
        unknown,
        targets.len() - resolved
    );
    scored.into_iter().filter(|a| !vetoed.contains(a.name.as_str())).collect()
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use axum::extract::{Query, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;

    #[derive(Clone, Copy)]
    pub enum Mode {
        Normal,
        Http429,
        QuotaError,
        Slow(Duration),
    }

    #[derive(Clone)]
    struct Mock {
        fans: Arc<HashMap<String, u64>>,
        hits: Arc<AtomicUsize>,
        mode: Mode,
    }

    async fn search(State(m): State<Mock>, Query(q): Query<HashMap<String, String>>) -> Response {
        m.hits.fetch_add(1, Ordering::SeqCst);
        match m.mode {
            Mode::Http429 => return (StatusCode::TOO_MANY_REQUESTS, "slow down").into_response(),
            Mode::QuotaError => {
                return Json(json!({"error": {"type": "Exception", "message": "Quota limit exceeded", "code": 4}}))
                    .into_response()
            }
            Mode::Slow(d) => tokio::time::sleep(d).await,
            Mode::Normal => {}
        }
        let name = q.get("q").cloned().unwrap_or_default();
        // A non-matching decoy first, as the real API returns near-matches.
        let mut data = vec![json!({"name": format!("{name} Tribute Band"), "nb_fan": 999_999})];
        if let Some(f) = m.fans.get(&name) {
            data.push(json!({"name": name, "nb_fan": f}));
        }
        Json(json!({"data": data, "total": data.len()})).into_response()
    }

    /// Spawn a mock Deezer on an ephemeral port: (base url, request counter).
    pub async fn spawn(fans: &[(&str, u64)], mode: Mode) -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let mock = Mock {
            fans: Arc::new(fans.iter().map(|(n, f)| (n.to_string(), *f)).collect()),
            hits: Arc::clone(&hits),
            mode,
        };
        let app = Router::new().route("/search/artist", get(search)).with_state(mock);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), hits)
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::{spawn, Mode};
    use super::*;
    use crate::cache::InMemoryStore;
    use std::sync::atomic::Ordering;

    fn mem() -> CacheStore {
        CacheStore::InMemory(InMemoryStore::new())
    }

    fn item(name: &str, tags: &[&str]) -> DiscoveryResponseItem {
        DiscoveryResponseItem {
            name: name.to_string(),
            stickiness_score: 0.0,
            conviction_score: 0,
            composite_score: 0.0,
            total_listeners: 1000,
            top_tags: tags.iter().map(|t| t.to_string()).collect(),
            source_seeds: vec![],
            cross_validated: false,
            taste_alignment: 0.0,
            velocity: None,
            user_playcount: 0,
            reengagement: false,
            spotify_url: None,
            bandcamp_url: None,
            this_is_url: None,
            rec_id: None,
        }
    }

    #[test]
    fn scope_matches_real_spike_tag_lists() {
        // From tmp/spotify-spike/arts.json.
        assert!(in_scope(&["Hindie", "Indian"]));
        assert!(in_scope(&["pop rock", "alternative", "Indian"]));
        assert!(in_scope(&["Indian", "jazz-rap", "Desi Hip Hop"]));
        assert!(in_scope(&["dance", "electronic", "india"]));
        assert!(in_scope(&["desi-hip-hop"]), "hyphens read as spaces");
        // Western niche metal is out of scope; so is classical Indian music.
        assert!(!in_scope(&["death metal", "brutal death metal", "american"]));
        assert!(!in_scope(&["carnatic", "hindustani classical", "classical"]));
        // Only the first five tags count.
        assert!(!in_scope(&["a", "b", "c", "d", "e", "indian"]));
        assert!(in_scope(&["a", "b", "c", "d", "punjabi"]));
        let none: [&str; 0] = [];
        assert!(!in_scope(&none));
    }

    #[test]
    fn settings_kill_switch_and_threshold() {
        assert!(DeezerClient::from_settings(Some("off"), None, None).is_none());
        assert!(DeezerClient::from_settings(Some(" OFF "), None, None).is_none());
        assert_eq!(DeezerClient::from_settings(None, None, None).unwrap().veto_fans(), 2000);
        assert_eq!(DeezerClient::from_settings(Some("on"), Some("5000"), None).unwrap().veto_fans(), 5000);
        assert_eq!(DeezerClient::from_settings(None, Some("junk"), None).unwrap().veto_fans(), 2000);
    }

    #[tokio::test]
    async fn name_matching_ignores_case_punctuation_and_ampersand() {
        // The mock answers with the exact query string as the artist name, so
        // the stored name differs from the lookup only by what normalization absorbs.
        let (base, _) = spawn(&[("Vishal & Shekhar", 9000), ("Ali Azmat", 8000)], Mode::Normal).await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        assert_eq!(d.fan_count(&c, "Vishal & Shekhar").await, Some(9000));
        assert_eq!(d.fan_count(&c, "Ali Azmat").await, Some(8000));
        // Decoy-only response ("X Tribute Band") is not an exact match.
        assert_eq!(d.fan_count(&c, "Nobody Here").await, None);
        assert_eq!(normalize_artist_name("Vishal & Shekhar"), normalize_artist_name("vishal and shekhar!"));
    }

    #[tokio::test]
    async fn cache_hit_avoids_network_and_unknown_is_cached() {
        let (base, hits) = spawn(&[("Arjan Dhillon", 4208)], Mode::Normal).await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        assert_eq!(d.fan_count(&c, "Arjan Dhillon").await, Some(4208));
        assert_eq!(d.fan_count(&c, "arjan dhillon").await, Some(4208));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "second lookup must come from cache");
        assert_eq!(d.fan_count(&c, "Nobody Here").await, None);
        assert_eq!(d.fan_count(&c, "Nobody Here").await, None);
        assert_eq!(hits.load(Ordering::SeqCst), 2, "no-match result is cached too");
    }

    #[tokio::test]
    async fn http_429_starts_cooldown_and_stops_calls_without_caching() {
        let (base, hits) = spawn(&[("A", 5000)], Mode::Http429).await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        assert_eq!(d.fan_count(&c, "A").await, None);
        assert!(d.degraded());
        assert_eq!(d.fan_count(&c, "B").await, None);
        assert_eq!(d.fan_count(&c, "C").await, None);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "cooldown must stop further calls");
        assert!(c.get_json::<CachedFans>(&cache_key("a")).await.is_none(), "failures are never cached");
    }

    #[tokio::test]
    async fn quota_error_code_4_starts_cooldown() {
        let (base, hits) = spawn(&[], Mode::QuotaError).await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        assert_eq!(d.fan_count(&c, "A").await, None);
        assert_eq!(d.fan_count(&c, "B").await, None);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(d.degraded());
    }

    #[tokio::test]
    async fn window_full_fails_open_without_calling() {
        let (base, hits) = spawn(&[], Mode::Normal).await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        for i in 0..(WINDOW_MAX_CALLS + 5) {
            d.fan_count(&c, &format!("Artist {i}")).await;
        }
        assert_eq!(hits.load(Ordering::SeqCst), WINDOW_MAX_CALLS);
    }

    #[tokio::test]
    async fn budget_timeout_keeps_unresolved_candidates() {
        let (base, _) = spawn(&[("Star", 9999)], Mode::Slow(Duration::from_secs(2))).await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        let cfg = Some(VetoConfig { deezer: &d, cache: &c });
        let started = Instant::now();
        let out = apply_veto_with_budget(vec![item("Star", &["punjabi"])], cfg, Duration::from_millis(200)).await;
        assert!(started.elapsed() < Duration::from_millis(1500), "budget must bound the stage");
        assert_eq!(out.len(), 1, "unresolved candidate is kept");
    }

    #[tokio::test]
    async fn veto_drops_in_scope_stars_only() {
        let (base, hits) = spawn(
            &[("Star", 4208), ("Indie", 500), ("Metal Band", 5000)],
            Mode::Normal,
        )
        .await;
        let d = DeezerClient::new(&base, 2000);
        let c = mem();
        let cfg = Some(VetoConfig { deezer: &d, cache: &c });
        let input = vec![
            item("Star", &["punjabi"]),
            item("Indie", &["indian", "indie"]),
            item("Metal Band", &["death metal"]),
        ];
        let out = apply_veto(input, cfg).await;
        let names: Vec<&str> = out.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["Indie", "Metal Band"]);
        assert_eq!(hits.load(Ordering::SeqCst), 2, "out-of-scope artist is never looked up");
    }

    #[tokio::test]
    async fn disabled_veto_is_a_noop() {
        let out = apply_veto(vec![item("Star", &["punjabi"])], None).await;
        assert_eq!(out.len(), 1);
    }

    /// Replays the spike corpus against the real Deezer API. Run by hand:
    /// `DEEZER_SPIKE_JSON=<path to arts.json> cargo test real_data_spike_replay -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_data_spike_replay() {
        let path = std::env::var("DEEZER_SPIKE_JSON").expect("set DEEZER_SPIKE_JSON");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let d = DeezerClient::new(DEFAULT_BASE, DEFAULT_VETO_FANS);
        let c = mem();
        let (mut vetoed, mut kept, mut out_of_scope, mut unknown) = (vec![], vec![], 0usize, vec![]);
        for (name, e) in v.as_object().unwrap() {
            let tags: Vec<String> = e["tags"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
            if !in_scope(&tags) {
                out_of_scope += 1;
                continue;
            }
            match d.fan_count(&c, name).await {
                Some(f) if f >= d.veto_fans() => vetoed.push(format!("{name} ({f})")),
                Some(f) => kept.push(format!("{name} ({f})")),
                None => unknown.push(name.clone()),
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        println!("OUT_OF_SCOPE {out_of_scope}");
        println!("VETOED {}: {}", vetoed.len(), vetoed.join("; "));
        println!("KEPT {}: {}", kept.len(), kept.join("; "));
        println!("UNKNOWN {}: {}", unknown.len(), unknown.join("; "));
        println!("DEGRADED {}", d.degraded());
    }
}
