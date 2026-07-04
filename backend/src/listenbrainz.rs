//! ListenBrainz candidate-source client — the additive second discovery graph.
//!
//! Mirrors `eval/listenbrainz.py` (the reference implementation that the SHIP
//! verdict `docs/blend-n348-2026-07-03.md` validated): a second candidate path
//! alongside Last.fm's `artist.getsimilar`, sourced from
//! `labs.api.listenbrainz.org`'s community-listening-session similar-artists
//! endpoint. It is MBID-keyed (not name-keyed), so names are resolved to
//! MusicBrainz IDs in two tiers before the graph can be queried:
//!
//!   1. Last.fm's own `artist.getinfo` `mbid` field (free — reuses the pool).
//!   2. MusicBrainz `/ws/2/artist` search, accepted only at score >= 80.
//!
//! ## Fail-open (deliberately different from Last.fm's fail-closed rule)
//! The Last.fm candidate path is fail-CLOSED: a transient failure aborts the
//! whole request so the pool stays deterministic (pool determinism drives the
//! cache key + persisted run). ListenBrainz is purely ADDITIVE, so it is
//! fail-OPEN: if LB is slow or down, the request degrades to Last.fm-only
//! candidates and never errors or meaningfully delays a discovery. The 8s
//! per-request time budget (see `candidates.rs`) enforces this: whatever LB
//! answered within budget is blended, the rest is skipped and the request is
//! counted as degraded. NEVER convert an LB failure into a request failure.
//! The budget runs CONCURRENTLY with the Last.fm arm (the two arms race — see
//! `candidates.rs::race_arms`), overlapping LB's window with Last.fm's work
//! rather than following it; a Last.fm-arm error drops the in-flight LB future
//! in place (it is never spawned, so cancellation leaks nothing).
//!
//! ## Caching (mandatory before the lever is flipped)
//! Every similar-artists and MBID resolution is cached through the shared
//! `CacheStore` (in-memory default, Redis when `REDIS_URL` is set) with a LONG
//! 7-day TTL — LB similarity is stable. Both hits AND definitive misses
//! (unresolvable names, empty neighbour lists) are cached so misses don't
//! re-fetch. Keys are user-agnostic (`lb:mbid:<norm>`, `lb:similar:<mbid>`).
//!
//! ## Politeness
//! The labs API has no key auth — do not hammer it. Bounded concurrency (4)
//! plus a small jittered spacing on the similar endpoint; MusicBrainz (which
//! explicitly asks for ~1 req/s) is serialized behind a 1s pacer. A descriptive
//! User-Agent is sent on both hosts (both ask for one).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, Semaphore};

use crate::cache::CacheStore;
use crate::lastfm::LastfmClient;
use crate::metrics::Metrics;
use crate::utils::normalize_artist_name;

const LB_SIMILAR_URL: &str = "https://labs.api.listenbrainz.org/similar-artists/json";
const MB_SEARCH_URL: &str = "https://musicbrainz.org/ws/2/artist/";

/// Fixed algorithm enum (the labs API rejects anything else) — long window,
/// moderate contribution/threshold floor, pre-filtered, limit 100. Identical to
/// the eval's `LB_ALGORITHM`, so the Rust engine queries the same graph the
/// n=348 SHIP verdict measured.
const LB_ALGORITHM: &str = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

const USER_AGENT: &str = concat!(
    "obscurity-engine/",
    env!("CARGO_PKG_VERSION"),
    " ( ListenBrainz blend candidate source; contact: gauravg@deepnative.ai )"
);

/// 7 days — LB similarity is stable, so cache aggressively (the verdict doc's
/// own caveat: caching is mandatory before the lever can be flipped in prod).
pub const LB_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

/// Bounded concurrency for the (no-auth) labs similar-artists endpoint.
const LB_SIMILAR_CONCURRENCY: usize = 4;
/// MusicBrainz asks for ~1 req/s — serialize and pace it.
const MB_MIN_INTERVAL: Duration = Duration::from_millis(1050);
/// MusicBrainz search score below this is a weak match — don't attach the wrong
/// artist (mirrors the eval's threshold).
const MB_SCORE_FLOOR: i64 = 80;

/// The candidate-generation source, selected by the `CANDIDATE_SOURCE` env var.
/// Default (and any unset/invalid value) is `Lastfm` — exactly today's behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateSource {
    /// Today's behavior: Last.fm `artist.getsimilar` only.
    Lastfm,
    /// ListenBrainz similar-artists only (structurally different graph).
    ListenBrainz,
    /// Union of both sources (the SHIP-verified `blend`).
    Blend,
}

impl CandidateSource {
    /// Parse `CANDIDATE_SOURCE`. Unset/blank/invalid → `Lastfm` (the safe default
    /// — the lever is flipped in prod only after review, never implicitly).
    pub fn from_env() -> Self {
        match std::env::var("CANDIDATE_SOURCE") {
            Ok(v) => Self::parse(&v),
            Err(_) => Self::Lastfm,
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "listenbrainz" => Self::ListenBrainz,
            "blend" => Self::Blend,
            _ => Self::Lastfm, // "lastfm", empty, and anything unrecognized
        }
    }

    /// Whether this source needs a ListenBrainz client wired up.
    pub fn uses_listenbrainz(self) -> bool {
        matches!(self, Self::ListenBrainz | Self::Blend)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lastfm => "lastfm",
            Self::ListenBrainz => "listenbrainz",
            Self::Blend => "blend",
        }
    }
}

/// A minimum-interval pacer: serializes callers so at most one request per
/// `min_interval` goes out on a host (used for MusicBrainz). Lock-protected
/// timestamp, not a token bucket — every caller awaits its turn.
struct Pacer {
    min_interval: Duration,
    last: Mutex<Option<Instant>>,
}

impl Pacer {
    fn new(min_interval: Duration) -> Self {
        Self { min_interval, last: Mutex::new(None) }
    }

    async fn wait(&self) {
        let mut guard = self.last.lock().await;
        if let Some(last) = *guard {
            let elapsed = last.elapsed();
            if elapsed < self.min_interval {
                tokio::time::sleep(self.min_interval - elapsed).await;
            }
        }
        *guard = Some(Instant::now());
    }
}

/// Cached MBID resolution. `mbid: None` is a *negative* cache entry (the name is
/// unresolvable via both tiers) — cached so we don't re-attempt it every run.
#[derive(Serialize, Deserialize)]
struct MbidCache {
    mbid: Option<String>,
}

/// Cached similar-artists list (already normalized + score-sorted). An empty
/// `neighbors` is a valid negative-cache entry (mbid genuinely has no LB
/// neighbours), so it is not re-fetched.
#[derive(Serialize, Deserialize)]
struct SimilarCache {
    neighbors: Vec<(String, f64)>,
}

pub struct ListenBrainzClient {
    http: Client,
    /// Bounds concurrent calls to the no-auth labs similar endpoint.
    sim_sem: Semaphore,
    /// Serializes MusicBrainz to one caller at a time (paired with `mb_pacer`).
    mb_sem: Semaphore,
    mb_pacer: Pacer,
    /// Liveness signal for `/api/status`: set true on any successful LB fetch,
    /// false when a similar-artists call fails at the transport/5xx level. A 404
    /// (unknown mbid) is a legitimate miss and does NOT flip this. Starts true so
    /// a fresh process with no traffic reads "ok".
    healthy: AtomicBool,
    /// Endpoints — the real hosts in production; injectable so unit tests can
    /// point at a local mock server (no live ListenBrainz/MusicBrainz in tests).
    similar_url: String,
    mb_url: String,
}

impl Default for ListenBrainzClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ListenBrainzClient {
    pub fn new() -> Self {
        Self::with_urls(LB_SIMILAR_URL.to_string(), MB_SEARCH_URL.to_string())
    }

    /// Construct with explicit endpoints (production uses `new`; tests point
    /// these at a local mock server).
    pub fn with_urls(similar_url: String, mb_url: String) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_default();
        Self {
            http,
            sim_sem: Semaphore::new(LB_SIMILAR_CONCURRENCY),
            mb_sem: Semaphore::new(1),
            mb_pacer: Pacer::new(MB_MIN_INTERVAL),
            healthy: AtomicBool::new(true),
            similar_url,
            mb_url,
        }
    }

    /// For `/api/status`. True when the last LB fetch succeeded (or none yet).
    pub fn healthy(&self) -> bool {
        self.healthy.load(Ordering::Relaxed)
    }

    /// Test-only: force the health flag (to exercise the `/api/status` "error"
    /// state without needing a real transport failure).
    #[cfg(test)]
    pub fn mark_unhealthy(&self) {
        self.healthy.store(false, Ordering::Relaxed);
    }

    // ── MBID resolution: Last.fm mbid (free) → MusicBrainz search ────────────

    /// Resolve an artist display name to a MusicBrainz ID, two-tier and cached
    /// (positive AND negative). Cache key uses `normalize_artist_name` so the
    /// dedup semantics match the rest of the pipeline.
    pub async fn resolve_mbid(
        &self,
        name: &str,
        lastfm: &LastfmClient,
        cache: &CacheStore,
        metrics: &Metrics,
    ) -> Option<String> {
        let key = format!("lb:mbid:{}", normalize_artist_name(name));
        if let Some(c) = cache.get_json::<MbidCache>(&key).await {
            metrics.record_lb_cache_hit();
            return c.mbid;
        }
        // Tier 1: Last.fm's own mbid field — a pool call (often already cached),
        // no new rate policy. Empty string counts as "no mbid".
        let mut mbid = lastfm
            .fetch_artist_mbid(name)
            .await
            .ok()
            .flatten()
            .filter(|m| !m.is_empty());
        // Tier 2: MusicBrainz search (rate-limited), only if tier 1 missed.
        if mbid.is_none() {
            mbid = self.mb_search(name).await;
        }
        // Cache the outcome either way (negative cache prevents re-attempts).
        cache.put_json(&key, &MbidCache { mbid: mbid.clone() }, LB_CACHE_TTL).await;
        mbid
    }

    async fn mb_search(&self, name: &str) -> Option<String> {
        let _permit = self.mb_sem.acquire().await.ok()?;
        self.mb_pacer.wait().await;
        let query = format!("artist:\"{}\"", name);
        let resp = match self
            .http
            .get(&self.mb_url)
            .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "3")])
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return None, // network error → treat as unresolved (fail-open)
        };
        if !resp.status().is_success() {
            return None;
        }
        let v: Value = resp.json().await.ok()?;
        let best = v.get("artists")?.as_array()?.first()?;
        // MB search is relevance-ranked; take the top result only if strong.
        let score = best
            .get("score")
            .and_then(|s| s.as_i64().or_else(|| s.as_str().and_then(|x| x.parse().ok())))
            .unwrap_or(0);
        if score < MB_SCORE_FLOOR {
            return None;
        }
        best.get("id").and_then(|i| i.as_str()).map(str::to_string)
    }

    // ── similar-artists ──────────────────────────────────────────────────────

    /// Fetch (cached) the LB similar-artists neighbourhood for one MBID, as
    /// `(display_name, normalized_match)` pairs. LB's raw `score` is an unbounded
    /// listening-session co-occurrence count, so it is normalized per-seed by the
    /// max so it composes with the pipeline's conviction math the same way
    /// Last.fm's already-0..1 `match` does. Infallible: any failure returns `[]`
    /// (fail-open) — but transport/5xx failures also flip the health flag and are
    /// NOT cached (so a transient outage doesn't poison the cache with an empty).
    pub async fn similar(
        &self,
        mbid: &str,
        limit: usize,
        cache: &CacheStore,
        metrics: &Metrics,
    ) -> Vec<(String, f64)> {
        let key = format!("lb:similar:{}", mbid);
        if let Some(c) = cache.get_json::<SimilarCache>(&key).await {
            metrics.record_lb_cache_hit();
            return c.neighbors.into_iter().take(limit).collect();
        }

        let _permit = match self.sim_sem.acquire().await {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        // Small jittered spacing so a burst of permit-holders doesn't fire in
        // lockstep against the no-auth labs endpoint.
        let jitter = 50 + (rand::random::<u64>() % 150);
        tokio::time::sleep(Duration::from_millis(jitter)).await;

        let resp = match self
            .http
            .get(&self.similar_url)
            .query(&[("artist_mbids", mbid), ("algorithm", LB_ALGORITHM)])
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                self.healthy.store(false, Ordering::Relaxed);
                return Vec::new();
            }
        };
        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::NOT_FOUND {
                // Unknown mbid — a stable, legitimate miss: negative-cache it.
                cache
                    .put_json(&key, &SimilarCache { neighbors: Vec::new() }, LB_CACHE_TTL)
                    .await;
            } else {
                // 5xx / 429 / etc — transient. Don't cache; mark unhealthy.
                self.healthy.store(false, Ordering::Relaxed);
            }
            return Vec::new();
        }
        let v: Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        self.healthy.store(true, Ordering::Relaxed);

        let neighbors = normalize_similar(&v);
        // Cache the full normalized+sorted list (empty included = negative cache).
        cache.put_json(&key, &SimilarCache { neighbors: neighbors.clone() }, LB_CACHE_TTL).await;
        neighbors.into_iter().take(limit).collect()
    }
}

/// Parse the labs similar-artists JSON array into normalized, score-sorted
/// `(name, match)` pairs. Pulled out as a pure fn so it is unit-testable without
/// a network. Mirrors `eval/listenbrainz.py`'s `similar()` normalization.
fn normalize_similar(v: &Value) -> Vec<(String, f64)> {
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    let score_of = |a: &Value| -> f64 {
        a.get("score")
            .and_then(|s| s.as_f64().or_else(|| s.as_str().and_then(|x| x.parse().ok())))
            .unwrap_or(0.0)
    };
    let max_score = arr.iter().map(score_of).fold(0.0_f64, f64::max);
    let max_score = if max_score > 0.0 { max_score } else { 1.0 };
    let mut scored: Vec<(&Value, f64)> = arr.iter().map(|a| (a, score_of(a))).collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .filter_map(|(a, raw)| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|name| (name.to_string(), raw / max_score))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_source_parse_matrix() {
        assert_eq!(CandidateSource::parse("lastfm"), CandidateSource::Lastfm);
        assert_eq!(CandidateSource::parse("listenbrainz"), CandidateSource::ListenBrainz);
        assert_eq!(CandidateSource::parse("blend"), CandidateSource::Blend);
        // case / whitespace insensitivity
        assert_eq!(CandidateSource::parse("  BLEND "), CandidateSource::Blend);
        assert_eq!(CandidateSource::parse("ListenBrainz"), CandidateSource::ListenBrainz);
        // unset/invalid → the safe default, exactly today's behavior
        assert_eq!(CandidateSource::parse(""), CandidateSource::Lastfm);
        assert_eq!(CandidateSource::parse("nonsense"), CandidateSource::Lastfm);
        assert_eq!(CandidateSource::parse("LASTFM"), CandidateSource::Lastfm);
        assert!(!CandidateSource::Lastfm.uses_listenbrainz());
        assert!(CandidateSource::ListenBrainz.uses_listenbrainz());
        assert!(CandidateSource::Blend.uses_listenbrainz());
    }

    #[test]
    fn normalize_similar_scales_by_max_and_sorts() {
        let v = serde_json::json!([
            { "name": "Beta", "score": 5 },
            { "name": "Alpha", "score": 10 },
            { "name": "Gamma", "score": 0 },
        ]);
        let out = normalize_similar(&v);
        assert_eq!(out[0], ("Alpha".to_string(), 1.0)); // top = max, normalized to 1.0
        assert_eq!(out[1], ("Beta".to_string(), 0.5));
        assert_eq!(out[2], ("Gamma".to_string(), 0.0));
    }

    #[test]
    fn normalize_similar_handles_string_scores_and_missing_names() {
        let v = serde_json::json!([
            { "name": "A", "score": "20" },
            { "score": 40 },              // no name → dropped
            { "name": "B", "score": "10" },
        ]);
        let out = normalize_similar(&v);
        // Two named entries survive; normalized by global max (40).
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], ("A".to_string(), 0.5));
        assert_eq!(out[1], ("B".to_string(), 0.25));
    }

    #[test]
    fn normalize_similar_empty_and_nonarray() {
        assert!(normalize_similar(&serde_json::json!([])).is_empty());
        assert!(normalize_similar(&serde_json::json!({ "not": "an array" })).is_empty());
    }

    // ── Mock-server tests: cache hit/miss/negative, fail-open, MB score gate ──
    // No live ListenBrainz/MusicBrainz — a local axum server stands in.

    use crate::cache::{CacheStore, InMemoryStore};
    use crate::metrics::Metrics;
    use axum::{extract::{Query, State}, routing::get, Json, Router};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn mem_cache() -> CacheStore {
        CacheStore::InMemory(InMemoryStore::new())
    }

    /// Spin a mock similar-artists server on an ephemeral port. It counts the
    /// requests it actually serves (so tests can prove a second call was a cache
    /// hit) and returns canned neighbours keyed by the `artist_mbids` query.
    async fn spawn_similar_mock() -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/",
                get(|Query(q): Query<HashMap<String, String>>, State(h): State<Arc<AtomicUsize>>| async move {
                    h.fetch_add(1, Ordering::Relaxed);
                    let mbid = q.get("artist_mbids").cloned().unwrap_or_default();
                    if mbid == "empty" {
                        Json(serde_json::json!([]))
                    } else {
                        Json(serde_json::json!([
                            { "name": "Alpha", "score": 10 },
                            { "name": "Beta", "score": 5 },
                        ]))
                    }
                }),
            )
            .with_state(Arc::clone(&hits));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        (format!("http://{}/", addr), hits)
    }

    #[tokio::test]
    async fn similar_cache_hit_miss_and_negative_cache() {
        let (url, hits) = spawn_similar_mock().await;
        let client = ListenBrainzClient::with_urls(url, "unused".into());
        let cache = mem_cache();
        let metrics = Metrics::new();

        // Miss → fetches, normalizes, caches. Server sees exactly one request.
        let first = client.similar("mbid1", 20, &cache, &metrics).await;
        assert_eq!(first, vec![("Alpha".into(), 1.0), ("Beta".into(), 0.5)]);
        assert_eq!(hits.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.snapshot().lb_cache_hits, 0);

        // Hit → identical result, NO new server request, cache-hit counted.
        let second = client.similar("mbid1", 20, &cache, &metrics).await;
        assert_eq!(second, first);
        assert_eq!(hits.load(Ordering::Relaxed), 1, "second call served from cache");
        assert_eq!(metrics.snapshot().lb_cache_hits, 1);

        // Negative cache: an empty neighbour list is cached, not re-fetched.
        let empty1 = client.similar("empty", 20, &cache, &metrics).await;
        assert!(empty1.is_empty());
        assert_eq!(hits.load(Ordering::Relaxed), 2);
        let empty2 = client.similar("empty", 20, &cache, &metrics).await;
        assert!(empty2.is_empty());
        assert_eq!(hits.load(Ordering::Relaxed), 2, "empty result negative-cached");
        assert_eq!(metrics.snapshot().lb_cache_hits, 2);
    }

    #[tokio::test]
    async fn similar_fail_open_on_transport_error() {
        // Port 9 (discard) is expected closed → connection refused fast. The
        // client must degrade to [] and flip its health flag, never hang/panic.
        let client = ListenBrainzClient::with_urls("http://127.0.0.1:9/".into(), "unused".into());
        let cache = mem_cache();
        let metrics = Metrics::new();
        assert!(client.healthy(), "starts healthy");
        let out = client.similar("mbid1", 20, &cache, &metrics).await;
        assert!(out.is_empty(), "transport error degrades to no candidates (fail-open)");
        assert!(!client.healthy(), "transport failure flips health to error");
    }

    #[tokio::test]
    async fn mb_search_accepts_strong_rejects_weak() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                let query = q.get("query").cloned().unwrap_or_default();
                // Weak match for names containing "weak", strong otherwise.
                let score = if query.to_lowercase().contains("weak") { 50 } else { 95 };
                Json(serde_json::json!({ "artists": [ { "id": "resolved-id", "score": score } ] }))
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let url = format!("http://{}/", addr);
        let client = ListenBrainzClient::with_urls("unused".into(), url);

        assert_eq!(client.mb_search("StrongMatch").await, Some("resolved-id".into()));
        assert_eq!(client.mb_search("WeakMatch").await, None, "score < 80 rejected");
    }
}
