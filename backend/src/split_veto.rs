// Split-page vetoes: drop candidates that look obscure only because Last.fm
// splits a mainstream artist's audience across several pages.
//
// Two shapes of split, two vetoes, both run after ranking and before
// `post_process` truncates (so the list backfills), concurrently with the
// Deezer veto and under one shared time budget:
//
// * Collab credit pages. "Asha Bhosle, Mohammed Rafi" has 3,958 listeners while
//   "Asha Bhosle" has 172,778 and "Mohammed Rafi" 137,790. The name is split on
//   a short list of unambiguous separators; the page is vetoed when a member's
//   own page is at or above the obscurity ceiling AND shares a top-5 tag with
//   the collab page. The tag guard stops a small duo being vetoed because an
//   unrelated homonym member page ("Kim") is huge.
// * Alias pages. "R.D. Burman" (14,851) and "Rahul Dev Burman" (10,661) are one
//   person. MusicBrainz knows the aliases (`artist_meta.aliases`, filled by the
//   background worker), so this veto reads them from storage and never calls
//   MusicBrainz itself. A candidate with no stored aliases is kept and queued
//   for the worker, so the next discovery can decide: eventual, zero latency.
//
// Failure policy is fail-open everywhere: a lookup error, a timeout, an
// exhausted budget, a storage error and a kill switch (`COLLAB_VETO=off`,
// `ALIAS_VETO=off`) all KEEP the candidate. A missed veto is a cosmetic miss;
// hiding an obscure artist is the product failing.
//
// Runtime hygiene: no lock is held across an await (the per-request memo hands
// out `Arc<OnceCell>` handles and releases its mutex first), and nothing counted
// lives across a cancellation point, because the whole stage is dropped when
// the budget expires.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use futures::future::join_all;
use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{OnceCell, Semaphore};

use crate::artist_meta::{enqueue_background, name_key, read_stored, Stored};
use crate::cache::CacheStore;
use crate::deezer::norm_tag;
use crate::lastfm::{ArtistPage, LastfmClient};
use crate::models::DiscoveryResponseItem;
use crate::pipeline::MAX_LISTENER_CEILING;
use crate::AppState;

/// Total wall-clock the split vetoes may add to one discovery.
pub const SPLIT_BUDGET: Duration = Duration::from_secs(4);
/// Ranked candidates examined per veto (collab: the first 40 multi-artist names).
const MAX_CHECKED: usize = 40;
/// Collab members looked up per name.
const MAX_MEMBERS: usize = 4;
/// Candidates queued for MusicBrainz per request.
const MAX_ENQUEUE: usize = 20;
/// Concurrent Last.fm page lookups per request.
const LASTFM_CONCURRENCY: usize = 8;
const TAG_WINDOW: usize = 5;
const FOUND_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const NOT_FOUND_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

/// Separators that mean "several credited artists". " and ", " x ", "/" and "+"
/// are deliberately absent: they are part of real names (Simon and Garfunkel,
/// Florence + The Machine). Longer separators first, so " feat. " wins over " feat ".
const SEPARATORS: &[&str] = &[", ", " & ", " feat. ", " feat ", " ft. ", " featuring "];

/// Collab members that are generic words, never a specific artist. Their
/// Last.fm pages are unrelated homonyms ("S.P. Balasubrahmanyam, Jojo & Chorus"
/// was vetoed through a 109K "Chorus" page on the shared "soundtrack" tag), and
/// qawwali credits like "X & Party" are exactly the obscure acts to protect.
/// "strings" is deliberately absent: Strings is a real Pakistani band.
const GENERIC_MEMBERS: &[&str] = &[
    "chorus", "orchestra", "his orchestra", "her orchestra", "the orchestra",
    "ensemble", "choir", "band", "the band", "party", "troupe", "group",
    "friends", "various artists", "sisters", "brothers",
];

fn is_generic_member(member: &str) -> bool {
    let m = member.trim().to_lowercase();
    GENERIC_MEMBERS.contains(&m.as_str())
}

/// Kill switches, read per request (`COLLAB_VETO=off`, `ALIAS_VETO=off`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitSwitches {
    pub collab: bool,
    pub alias: bool,
}

impl SplitSwitches {
    pub fn from_env() -> Self {
        Self::from_settings(
            std::env::var("COLLAB_VETO").ok().as_deref(),
            std::env::var("ALIAS_VETO").ok().as_deref(),
        )
    }

    pub fn from_settings(collab: Option<&str>, alias: Option<&str>) -> Self {
        Self { collab: !crate::utils::switch_is_off(collab), alias: !crate::utils::switch_is_off(alias) }
    }

    pub fn any(&self) -> bool {
        self.collab || self.alias
    }
}

/// What the split vetoes need from the application.
#[derive(Clone, Copy)]
pub struct SplitConfig<'a> {
    pub state: &'a Arc<AppState>,
    pub switches: SplitSwitches,
}

/// Credited members of a multi-artist name, or empty when it is not one (fewer
/// than two non-empty members). Case-insensitive, whole separators only.
pub fn split_collab(name: &str) -> Vec<String> {
    // ASCII lowercasing keeps byte offsets identical to `name`.
    let lower = name.to_ascii_lowercase();
    let mut members: Vec<String> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < lower.len() {
        match SEPARATORS.iter().find(|sep| lower[i..].starts_with(*sep)) {
            Some(sep) => {
                members.push(name[start..i].to_string());
                i += sep.len();
                start = i;
            }
            None => i += lower[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    members.push(name[start..].to_string());
    let members: Vec<String> =
        members.into_iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
    if members.len() >= 2 {
        members
    } else {
        Vec::new()
    }
}

/// First tag of `a` (normalized, top five of each) that also appears in `b`.
fn shared_tag<A: AsRef<str>, B: AsRef<str>>(a: &[A], b: &[B]) -> Option<String> {
    let bn: HashSet<String> = b.iter().take(TAG_WINDOW).map(|t| norm_tag(t.as_ref())).collect();
    a.iter().take(TAG_WINDOW).map(|t| norm_tag(t.as_ref())).find(|t| !t.is_empty() && bn.contains(t))
}

#[derive(Serialize, Deserialize)]
struct CachedPage {
    page: Option<ArtistPage>,
}

/// Per-request page lookups: 30-day cache, one in-flight lookup per distinct
/// (name, autocorrect), bounded concurrency.
struct Lookups<'a> {
    client: &'a LastfmClient,
    cache: &'a CacheStore,
    sem: Semaphore,
    memo: StdMutex<HashMap<String, Arc<OnceCell<Option<ArtistPage>>>>>,
    errors: AtomicUsize,
}

impl<'a> Lookups<'a> {
    fn new(client: &'a LastfmClient, cache: &'a CacheStore) -> Self {
        Self {
            client,
            cache,
            sem: Semaphore::new(LASTFM_CONCURRENCY),
            memo: StdMutex::new(HashMap::new()),
            errors: AtomicUsize::new(0),
        }
    }

    /// The page for `name`, or `None` for not found and for every failure.
    async fn page(&self, name: &str, autocorrect: bool) -> Option<ArtistPage> {
        let key = format!("split_page:{}:{}", u8::from(autocorrect), name.trim().to_lowercase());
        let cell = {
            let mut m = self.memo.lock().unwrap_or_else(|e| e.into_inner());
            Arc::clone(m.entry(key.clone()).or_default())
        };
        cell.get_or_init(|| async {
            if let Some(c) = self.cache.get_json::<CachedPage>(&key).await {
                return c.page;
            }
            let _permit = self.sem.acquire().await.ok()?;
            match self.client.fetch_artist_page(name, autocorrect).await {
                Ok(page) => {
                    let ttl = if page.is_some() { FOUND_TTL } else { NOT_FOUND_TTL };
                    self.cache.put_json(&key, &CachedPage { page: page.clone() }, ttl).await;
                    page
                }
                Err(_) => {
                    self.errors.fetch_add(1, Ordering::Relaxed);
                    None
                }
            }
        })
        .await
        .clone()
    }
}

/// Why a candidate was vetoed (for the log line and tests).
#[derive(Debug, Clone, PartialEq)]
pub struct Veto {
    pub name: String,
    pub detail: String,
}

/// Collab rule for one name. `own_tags` are the collab page's own tags.
async fn collab_verdict(lk: &Lookups<'_>, name: &str, own_tags: &[String]) -> Option<Veto> {
    let members: Vec<String> =
        split_collab(name).into_iter().filter(|m| !is_generic_member(m)).collect();
    if members.is_empty() {
        return None;
    }
    let pages = join_all(members.iter().take(MAX_MEMBERS).map(|m| lk.page(m, true))).await;
    for (member, page) in members.iter().zip(pages) {
        let Some(p) = page else { continue };
        if p.listeners < MAX_LISTENER_CEILING {
            continue;
        }
        if let Some(tag) = shared_tag(own_tags, &p.tags) {
            return Some(Veto {
                name: name.to_string(),
                detail: format!("member \"{member}\" {} listeners, shared tag \"{tag}\"", p.listeners),
            });
        }
    }
    None
}

/// Alias rule for one candidate with known aliases.
async fn alias_verdict(
    lk: &Lookups<'_>,
    item: &DiscoveryResponseItem,
    aliases: &[String],
    cand_mbid: Option<&str>,
) -> Option<Veto> {
    let own = item.name.trim().to_lowercase();
    let wanted: Vec<&String> = aliases.iter().filter(|a| a.trim().to_lowercase() != own).collect();
    let pages = join_all(wanted.iter().map(|a| lk.page(a, false))).await;
    // Page names already counted, so a page reached by two aliases, or the
    // candidate's own page, is never added twice.
    let mut seen: HashSet<String> = HashSet::from([own]);
    let mut total = item.total_listeners;
    let mut counted: Vec<String> = Vec::new();
    for (alias, page) in wanted.iter().zip(pages) {
        let Some(p) = page else { continue };
        if !seen.insert(p.name.trim().to_lowercase()) {
            continue;
        }
        let same_artist = match (&p.mbid, cand_mbid) {
            (Some(m), Some(c)) => m == c,
            (None, _) => shared_tag(&item.top_tags, &p.tags).is_some(),
            (Some(_), None) => false,
        };
        if same_artist {
            total += p.listeners;
            counted.push(format!("\"{alias}\" {}", p.listeners));
        }
    }
    (!counted.is_empty() && total >= MAX_LISTENER_CEILING).then(|| Veto {
        name: item.name.clone(),
        detail: format!("{} own + {} = {total}", item.total_listeners, counted.join(" + ")),
    })
}

/// What one request's split vetoes decided.
#[derive(Debug, Default)]
pub struct SplitOutcome {
    pub collab: Vec<Veto>,
    pub alias: Vec<Veto>,
}

impl SplitOutcome {
    pub fn names(&self) -> HashSet<String> {
        self.collab.iter().chain(&self.alias).map(|v| v.name.clone()).collect()
    }
}

/// Run the enabled split vetoes over the ranked list. `mbids` maps a candidate's
/// name to the mbid Last.fm returned for its page. Never fails: whatever is
/// decided inside `budget` is returned, the rest is kept.
pub async fn run(
    scored: &[DiscoveryResponseItem],
    client: &LastfmClient,
    mbids: &HashMap<String, String>,
    cfg: SplitConfig<'_>,
    budget: Duration,
) -> SplitOutcome {
    if !cfg.switches.any() {
        return SplitOutcome::default();
    }
    let started = Instant::now();
    let lk = Lookups::new(client, &cfg.state.cache);
    let collab_hits: StdMutex<Vec<(usize, Veto)>> = StdMutex::new(Vec::new());
    let alias_hits: StdMutex<Vec<(usize, Veto)>> = StdMutex::new(Vec::new());
    let collab_checked = AtomicUsize::new(0);
    let alias_checked = AtomicUsize::new(0);
    let mut enqueued = 0usize;
    let mut refreshed = 0usize;

    let collab_targets: Vec<usize> = if cfg.switches.collab {
        scored
            .iter()
            .enumerate()
            .filter(|(_, a)| !split_collab(&a.name).is_empty())
            .map(|(i, _)| i)
            .take(MAX_CHECKED)
            .collect()
    } else {
        Vec::new()
    };
    let alias_targets: Vec<usize> =
        if cfg.switches.alias { (0..scored.len().min(MAX_CHECKED)).collect() } else { Vec::new() };

    let stage = async {
        let mut futs: FuturesUnordered<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>> =
            FuturesUnordered::new();

        for &i in &collab_targets {
            let item = &scored[i];
            let (lk, hits, checked) = (&lk, &collab_hits, &collab_checked);
            futs.push(Box::pin(async move {
                let v = collab_verdict(lk, &item.name, &item.top_tags).await;
                checked.fetch_add(1, Ordering::Relaxed);
                if let Some(v) = v {
                    hits.lock().unwrap_or_else(|e| e.into_inner()).push((i, v));
                }
            }));
        }

        if !alias_targets.is_empty() {
            let keys: Vec<String> = alias_targets.iter().map(|&i| name_key(&scored[i].name)).collect();
            // Storage only (DB, else CacheStore). MusicBrainz is never called here.
            let stored = read_stored(cfg.state, &keys).await;
            let now = chrono::Utc::now();
            for (&i, key) in alias_targets.iter().zip(&keys) {
                let item = &scored[i];
                let row: Option<&Stored> = stored.get(key);
                let needs_queue = match row {
                    None => true,
                    Some(s) if s.mbid.is_some() => s.aliases.is_none(),
                    Some(s) => s.is_stale_miss(now),
                };
                if needs_queue && enqueued < MAX_ENQUEUE && enqueue_background(cfg.state, &item.name) {
                    enqueued += 1;
                    if row.is_some() {
                        refreshed += 1;
                    }
                }
                let Some(aliases) = row.and_then(|s| s.aliases.clone()).filter(|a| !a.is_empty()) else {
                    continue;
                };
                let cand_mbid =
                    mbids.get(&item.name).cloned().or_else(|| row.and_then(|s| s.mbid.clone()));
                let (lk, hits, checked) = (&lk, &alias_hits, &alias_checked);
                futs.push(Box::pin(async move {
                    let v = alias_verdict(lk, item, &aliases, cand_mbid.as_deref()).await;
                    checked.fetch_add(1, Ordering::Relaxed);
                    if let Some(v) = v {
                        hits.lock().unwrap_or_else(|e| e.into_inner()).push((i, v));
                    }
                }));
            }
        }
        while futs.next().await.is_some() {}
    };
    let finished = tokio::time::timeout(budget, stage).await.is_ok();

    let take = |m: StdMutex<Vec<(usize, Veto)>>| {
        let mut v = m.into_inner().unwrap_or_else(|e| e.into_inner());
        v.sort_by_key(|(i, _)| *i);
        v.into_iter().map(|(_, v)| v).collect::<Vec<_>>()
    };
    let out = SplitOutcome { collab: take(collab_hits), alias: take(alias_hits) };
    println!(
        "SPLIT_VETO: collab checked {}/{} vetoed {} [{}]; alias checked {} vetoed {} [{}]; \
         queued {} for MusicBrainz ({} refresh); {} lookup errors; {}ms{}",
        collab_checked.load(Ordering::Relaxed),
        collab_targets.len(),
        out.collab.len(),
        out.collab.iter().map(|v| format!("{}: {}", v.name, v.detail)).collect::<Vec<_>>().join("; "),
        alias_checked.load(Ordering::Relaxed),
        out.alias.len(),
        out.alias.iter().map(|v| format!("{}: {}", v.name, v.detail)).collect::<Vec<_>>().join("; "),
        enqueued,
        refreshed,
        lk.errors.load(Ordering::Relaxed),
        started.elapsed().as_millis(),
        if finished { "" } else { " (budget exhausted, rest kept)" },
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::extract::{Query, State};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;

    use crate::artist_meta::{write_stored, ArtistMetaService};
    use crate::lastfm::test_base::MockLastfmBase;
    use crate::listenbrainz::{CandidateSource, ListenBrainzClient};
    use crate::models::ArtistMetaEntry;

    #[derive(Clone)]
    enum Reply {
        Page { name: &'static str, listeners: u64, mbid: Option<&'static str>, tags: Vec<&'static str> },
        NotFound,
        AppError(u32),
        Slow(Duration),
    }

    type Hits = Arc<StdMutex<Vec<(String, bool)>>>;

    #[derive(Clone)]
    struct Mock {
        /// Keyed (lowercased artist param, autocorrect=1).
        replies: Arc<HashMap<(String, bool), Reply>>,
        hits: Hits,
    }

    async fn getinfo(State(m): State<Mock>, Query(q): Query<HashMap<String, String>>) -> Json<serde_json::Value> {
        let name = q.get("artist").cloned().unwrap_or_default().to_lowercase();
        let ac = q.get("autocorrect").is_some_and(|v| v == "1");
        m.hits.lock().unwrap().push((name.clone(), ac));
        let reply = m.replies.get(&(name, ac)).cloned().unwrap_or(Reply::NotFound);
        if let Reply::Slow(d) = reply {
            tokio::time::sleep(d).await;
            return Json(json!({"error": 6, "message": "slow"}));
        }
        Json(match reply {
            Reply::Page { name, listeners, mbid, tags } => json!({"artist": {
                "name": name, "mbid": mbid.unwrap_or(""),
                "stats": {"listeners": listeners.to_string(), "playcount": "1"},
                "tags": {"tag": tags.iter().map(|t| json!({"name": t})).collect::<Vec<_>>()}}}),
            Reply::AppError(c) => json!({"error": c, "message": "nope"}),
            _ => json!({"error": 6, "message": "The artist you supplied could not be found"}),
        })
    }

    async fn spawn_lastfm(replies: Vec<((&str, bool), Reply)>) -> (MockLastfmBase, Hits) {
        let hits: Hits = Arc::new(StdMutex::new(Vec::new()));
        let mock = Mock {
            replies: Arc::new(replies.into_iter().map(|((n, ac), r)| ((n.to_lowercase(), ac), r)).collect()),
            hits: Arc::clone(&hits),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/", get(getinfo)).with_state(mock)).await.unwrap()
        });
        (MockLastfmBase::set(addr), hits)
    }

    fn page(name: &'static str, listeners: u64, mbid: Option<&'static str>, tags: &[&'static str]) -> Reply {
        Reply::Page { name, listeners, mbid, tags: tags.to_vec() }
    }

    fn item(name: &str, listeners: u64, tags: &[&str]) -> DiscoveryResponseItem {
        DiscoveryResponseItem {
            name: name.to_string(),
            stickiness_score: 0.0,
            conviction_score: 0,
            composite_score: 0.0,
            total_listeners: listeners,
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

    fn state(mb_url: &str) -> Arc<AppState> {
        use crate::{cache, metrics, ratelimit};
        Arc::new(AppState {
            client: Arc::new(LastfmClient::with_keys(vec!["TESTKEY".into()], None)),
            spotify: None,
            deezer: None,
            candidate_source: CandidateSource::Lastfm,
            listenbrainz: None,
            artist_meta: ArtistMetaService::build(
                Arc::new(ListenBrainzClient::with_urls("unused".into(), mb_url.into())),
                false,
            ),
            cache: cache::CacheStore::InMemory(cache::InMemoryStore::new()),
            metrics: Arc::new(metrics::Metrics::new()),
            db: None,
            db_configured: false,
            redis_configured: false,
            lastfm_secret: None,
            rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
        })
    }

    /// Nothing listens on port 9, so a background MusicBrainz call fails at once.
    const NO_MB: &str = "http://127.0.0.1:9/";

    async fn store_aliases(st: &Arc<AppState>, name: &str, mbid: Option<&str>, aliases: Option<Vec<&str>>) {
        let s = Stored {
            mbid: mbid.map(String::from),
            entry: ArtistMetaEntry::default(),
            fetched_at: chrono::Utc::now(),
            aliases: aliases.map(|a| a.into_iter().map(String::from).collect()),
        };
        write_stored(st, &name_key(name), &s).await;
    }

    async fn run_with(
        st: &Arc<AppState>,
        items: &[DiscoveryResponseItem],
        switches: SplitSwitches,
        budget: Duration,
    ) -> SplitOutcome {
        let cfg = SplitConfig { state: st, switches };
        run(items, &st.client, &HashMap::new(), cfg, budget).await
    }

    const ON: SplitSwitches = SplitSwitches { collab: true, alias: true };
    const COLLAB_ONLY: SplitSwitches = SplitSwitches { collab: true, alias: false };
    const ALIAS_ONLY: SplitSwitches = SplitSwitches { collab: false, alias: true };

    #[test]
    fn split_collab_splits_only_on_the_named_separators() {
        assert_eq!(split_collab("Asha Bhosle, Mohammed Rafi"), vec!["Asha Bhosle", "Mohammed Rafi"]);
        assert_eq!(split_collab("Kim & The Created"), vec!["Kim", "The Created"]);
        assert_eq!(split_collab("A feat. B"), vec!["A", "B"]);
        assert_eq!(split_collab("A FEAT B"), vec!["A", "B"]);
        assert_eq!(split_collab("A Ft. B"), vec!["A", "B"]);
        assert_eq!(split_collab("A Featuring B"), vec!["A", "B"]);
        assert_eq!(split_collab("Crosby, Stills & Nash"), vec!["Crosby", "Stills", "Nash"]);
        assert_eq!(split_collab("Bj\u{f6}rk & Sigur R\u{f3}s, X"), vec!["Bj\u{f6}rk", "Sigur R\u{f3}s", "X"]);
        for not_collab in [
            "Simon and Garfunkel", "Hall x Oates", "AC/DC", "Florence + The Machine",
            "Solo Artist", "Trailing, ", "& Leading", "Smith&Wesson", "Feat", "",
        ] {
            assert!(split_collab(not_collab).is_empty(), "{not_collab:?} must not split");
        }
    }

    #[tokio::test]
    async fn collab_rule_vetoes_split_pages_and_spares_everything_else() {
        let bolly = ["bollywood", "hindi", "indian"];
        let (_base, hits) = spawn_lastfm(vec![
            (("Asha Bhosle", true), page("Asha Bhosle", 172_778, Some("a1"), &["bollywood", "hindi", "oldies"])),
            (("Mohammed Rafi", true), page("Mohammed Rafi", 137_790, Some("a2"), &["bollywood", "ghazal"])),
            // A homonym member page: huge, unrelated tags.
            (("Kim", true), page("Kim", 900_000, None, &["k-pop", "korean"])),
            (("The Created", true), page("The Created", 300, None, &["indie"])),
            (("Simon and Garfunkel", true), page("Simon and Garfunkel", 4_000_000, None, &["folk"])),
            (("Lonely Artist", true), page("Lonely Artist", 4_000_000, None, &["folk"])),
            (("Broken", true), Reply::AppError(10)),
            (("Fine", true), page("Fine", 100, None, &["indie"])),
            (("Big Member", true), page("Big Member", 40_000, None, &["indie"])),
            (("Small Member", true), page("Small Member", 24_999, None, &["indie"])),
            // Generic member: a huge homonym page sharing a broad tag must not veto.
            (("Chorus", true), page("Chorus", 109_000, None, &["soundtrack"])),
            (("Jojo", true), page("Jojo", 900, None, &["tamil"])),
            (("S.P. Balasubrahmanyam", true), page("S.P. Balasubrahmanyam", 9_000, None, &["tamil"])),
        ])
        .await;
        let st = state(NO_MB);
        let items = vec![
            item("Asha Bhosle, Mohammed Rafi", 3_958, &bolly),
            item("Kim & The Created", 2_000, &["indie", "shoegaze"]),
            item("Simon and Garfunkel", 3_000, &["folk"]),
            item("Lonely Artist", 3_000, &["folk"]),
            item("Broken & Fine", 3_000, &["indie"]),
            item("Big Member & Small Member", 3_000, &["indie"]),
            item("S.P. Balasubrahmanyam, Jojo & Chorus", 1_200, &["tamil", "soundtrack"]),
        ];
        let out = run_with(&st, &items, COLLAB_ONLY, SPLIT_BUDGET).await;
        let names: Vec<_> = out.collab.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, vec!["Asha Bhosle, Mohammed Rafi", "Big Member & Small Member"], "{out:?}");
        let d = &out.collab[0].detail;
        assert!(d.contains("172778") && d.contains("bollywood"), "{d}");
        assert!(out.alias.is_empty());
        let looked_up: Vec<String> = hits.lock().unwrap().iter().map(|(n, _)| n.clone()).collect();
        assert!(!looked_up.contains(&"simon and garfunkel".to_string()), "no split on and: {looked_up:?}");
        assert!(!looked_up.contains(&"lonely artist".to_string()), "single names untouched: {looked_up:?}");
        assert!(!looked_up.contains(&"chorus".to_string()), "generic members never looked up: {looked_up:?}");
    }

    #[tokio::test]
    async fn collab_member_error_and_missing_member_keep_the_candidate() {
        let (_base, _hits) = spawn_lastfm(vec![
            (("Broken", true), Reply::AppError(10)),
            (("Gone", true), Reply::NotFound),
        ])
        .await;
        let st = state(NO_MB);
        let items = vec![item("Broken, Gone", 3_000, &["indie"])];
        let out = run_with(&st, &items, COLLAB_ONLY, SPLIT_BUDGET).await;
        assert!(out.names().is_empty(), "{out:?}");
    }

    #[tokio::test]
    async fn alias_rule_sums_same_artist_pages_only() {
        let (_base, _hits) = spawn_lastfm(vec![
            // Same person: same mbid.
            (("Rahul Dev Burman", false), page("Rahul Dev Burman", 10_661, Some("m-rd"), &["bollywood"])),
            (("Pancham", false), Reply::NotFound),
            // A different artist's page: different mbid, huge.
            (("Big Name", false), page("Big Name", 9_000_000, Some("m-other"), &["pop"])),
            // No mbid, unrelated tags: not counted however large.
            (("Noisy Page", false), page("Noisy Page", 9_000_000, None, &["noise"])),
            // No mbid, shared tag: counted.
            (("Tagged Page", false), page("Tagged Page", 30_000, None, &["hindi", "x"])),
            // The candidate's own page under another spelling: never added twice.
            (("Self Alias", false), page("Own Page Only", 14_851, Some("m-rd"), &["bollywood"])),
            // Two aliases reaching one page count once.
            (("Pancham Da", false), page("Rahul Dev Burman", 10_661, Some("m-rd"), &["bollywood"])),
            (("Little One", false), page("Little One", 1_000, Some("m-ds"), &["indie"])),
        ])
        .await;
        let st = state(NO_MB);
        store_aliases(&st, "R.D. Burman", Some("m-rd"), Some(vec!["Rahul Dev Burman", "Pancham"])).await;
        store_aliases(&st, "Diff Mbid", Some("m-diff"), Some(vec!["Big Name"])).await;
        store_aliases(&st, "No Tag Overlap", None, Some(vec!["Noisy Page"])).await;
        store_aliases(&st, "Tag Overlap", None, Some(vec!["Tagged Page"])).await;
        store_aliases(&st, "Own Page Only", Some("m-rd"), Some(vec!["Self Alias", "own page only"])).await;
        store_aliases(&st, "Counted Once", Some("m-rd"), Some(vec!["Rahul Dev Burman", "Pancham Da"])).await;
        store_aliases(&st, "Below Ceiling", Some("m-ds"), Some(vec!["Little One"])).await;
        store_aliases(&st, "No Aliases", Some("m-x"), Some(vec![])).await;
        let items = vec![
            item("R.D. Burman", 14_851, &["bollywood", "hindi"]),
            item("Diff Mbid", 5_000, &["pop"]),
            item("No Tag Overlap", 5_000, &["hindi"]),
            item("Tag Overlap", 5_000, &["hindi"]),
            item("Own Page Only", 14_851, &["bollywood"]),
            item("Counted Once", 14_851, &["bollywood"]),
            item("Below Ceiling", 5_000, &["indie"]),
            item("No Aliases", 5_000, &["indie"]),
        ];
        let out = run_with(&st, &items, ALIAS_ONLY, SPLIT_BUDGET).await;
        let names: Vec<_> = out.alias.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, vec!["R.D. Burman", "Tag Overlap", "Counted Once"], "{out:?}");
        assert!(out.alias[0].detail.contains("= 25512"), "{:?}", out.alias[0]);
        assert!(out.alias[2].detail.contains("= 25512"), "counted once, not twice: {:?}", out.alias[2]);
        assert!(out.collab.is_empty());
    }

    #[tokio::test]
    async fn alias_candidate_mbid_from_lastfm_is_used_when_storage_has_none() {
        let (_base, _h) = spawn_lastfm(vec![(
            ("Rahul Dev Burman", false),
            page("Rahul Dev Burman", 10_661, Some("m-rd"), &["bollywood"]),
        )])
        .await;
        let st = state(NO_MB);
        store_aliases(&st, "R.D. Burman", None, Some(vec!["Rahul Dev Burman"])).await;
        let items = vec![item("R.D. Burman", 14_851, &["x"])];
        let mbids = HashMap::from([("R.D. Burman".to_string(), "m-rd".to_string())]);
        let cfg = SplitConfig { state: &st, switches: ON };
        let out = run(&items, &st.client, &mbids, cfg, SPLIT_BUDGET).await;
        assert_eq!(out.names(), HashSet::from(["R.D. Burman".to_string()]), "{out:?}");
    }

    /// No stored row, or a row whose aliases were never fetched: kept, queued for
    /// the background worker, and the stage returns long before MusicBrainz could
    /// answer (the mock holds every MB request for 5 s), so nothing was awaited.
    #[tokio::test]
    async fn unknown_aliases_keep_the_candidate_and_queue_it_without_blocking() {
        let mb = Router::new().route(
            "/*any",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Json(json!({"artists": []}))
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mb_url = format!("http://{}/", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, mb).await.unwrap() });
        let (_base, hits) = spawn_lastfm(vec![]).await;
        let st = state(&mb_url);
        store_aliases(&st, "Needs Refresh", Some("m-1"), None).await;
        store_aliases(&st, "Fresh Miss", None, None).await;
        let items = vec![
            item("No Row", 5_000, &["indie"]),
            item("Needs Refresh", 5_000, &["indie"]),
            item("Fresh Miss", 5_000, &["indie"]),
        ];
        let t = Instant::now();
        let out = run_with(&st, &items, ALIAS_ONLY, SPLIT_BUDGET).await;
        assert!(t.elapsed() < Duration::from_secs(1), "stage waited on MusicBrainz: {:?}", t.elapsed());
        assert!(out.names().is_empty());
        let svc = &st.artist_meta;
        assert!(svc.is_in_flight(&name_key("No Row")), "no row: queued");
        assert!(svc.is_in_flight(&name_key("Needs Refresh")), "aliases never fetched: queued");
        assert!(!svc.is_in_flight(&name_key("Fresh Miss")), "a fresh stored miss is not retried per request");
        assert!(hits.lock().unwrap().is_empty(), "no Last.fm lookups without aliases");
    }

    #[tokio::test]
    async fn enqueue_is_bounded_per_request() {
        let (_base, _h) = spawn_lastfm(vec![]).await;
        let st = state(NO_MB);
        let items: Vec<_> = (0..40).map(|i| item(&format!("Unknown {i}"), 5_000, &["x"])).collect();
        run_with(&st, &items, ALIAS_ONLY, SPLIT_BUDGET).await;
        let queued =
            (0..40).filter(|i| st.artist_meta.is_in_flight(&name_key(&format!("Unknown {i}")))).count();
        assert_eq!(queued, MAX_ENQUEUE);
    }

    #[tokio::test]
    async fn kill_switches_disable_their_own_veto_only() {
        let (_base, _h) = spawn_lastfm(vec![
            (("Big", true), page("Big", 900_000, None, &["indie"])),
            (("Small", true), page("Small", 10, None, &["indie"])),
            (("Other Page", false), page("Other Page", 50_000, Some("m"), &["indie"])),
        ])
        .await;
        let st = state(NO_MB);
        store_aliases(&st, "Has Alias", Some("m"), Some(vec!["Other Page"])).await;
        let items = vec![item("Big & Small", 1_000, &["indie"]), item("Has Alias", 1_000, &["indie"])];
        let both = run_with(&st, &items, ON, SPLIT_BUDGET).await;
        assert_eq!((both.collab.len(), both.alias.len()), (1, 1), "{both:?}");
        let sw = SplitSwitches::from_settings(Some("off"), None);
        assert_eq!(sw, ALIAS_ONLY);
        let out = run_with(&st, &items, sw, SPLIT_BUDGET).await;
        assert_eq!((out.collab.len(), out.alias.len()), (0, 1));
        let sw = SplitSwitches::from_settings(None, Some(" OFF "));
        assert_eq!(sw, COLLAB_ONLY);
        let out = run_with(&st, &items, sw, SPLIT_BUDGET).await;
        assert_eq!((out.collab.len(), out.alias.len()), (1, 0));
        let none = SplitSwitches::from_settings(Some("off"), Some("off"));
        assert!(!none.any());
        assert!(run_with(&st, &items, none, SPLIT_BUDGET).await.names().is_empty());
    }

    #[tokio::test]
    async fn exhausted_budget_keeps_everything_and_returns_on_time() {
        let (_base, _h) = spawn_lastfm(vec![
            (("Big", true), Reply::Slow(Duration::from_secs(3))),
            (("Small", true), Reply::Slow(Duration::from_secs(3))),
        ])
        .await;
        let st = state(NO_MB);
        let items = vec![item("Big & Small", 1_000, &["indie"])];
        let t = Instant::now();
        let out = run_with(&st, &items, COLLAB_ONLY, Duration::from_millis(300)).await;
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert!(out.names().is_empty());
    }

    #[tokio::test]
    async fn page_lookups_are_shared_within_a_request_and_cached_across_requests() {
        let (_base, hits) = spawn_lastfm(vec![
            (("Asha Bhosle", true), page("Asha Bhosle", 172_778, None, &["hindi"])),
            (("Rafi", true), page("Rafi", 137_790, None, &["hindi"])),
        ])
        .await;
        let st = state(NO_MB);
        let items =
            vec![item("Asha Bhosle, Rafi", 100, &["hindi"]), item("Asha Bhosle & Rafi", 100, &["hindi"])];
        run_with(&st, &items, COLLAB_ONLY, SPLIT_BUDGET).await;
        assert_eq!(hits.lock().unwrap().len(), 2, "one Last.fm call per distinct member");
        run_with(&st, &items, COLLAB_ONLY, SPLIT_BUDGET).await;
        assert_eq!(hits.lock().unwrap().len(), 2, "second request served from the 30-day cache");
    }
}
