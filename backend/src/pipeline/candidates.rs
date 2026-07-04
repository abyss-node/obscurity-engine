/// Phase 2: expand seeds into discovery candidates via similar-artist traversal.
///
/// For each seed artist, fetches Last.fm's "similar artists" list. Candidates
/// that show up via multiple seeds accumulate more recommenders — this is the
/// raw input for conviction scoring in Phase 3.
///
/// The semaphore prevents thundering-herd against the Last.fm API.
///
/// ## Blend concurrency (Last.fm ∥ ListenBrainz)
/// When `CANDIDATE_SOURCE=blend`, the two candidate arms run CONCURRENTLY (see
/// `build_blended` / `race_arms`), not sequentially. Both operate on the SAME
/// seed list — the list computed by Phase 1 that already exists before either
/// arm starts. The LB arm has NO data dependency on the Last.fm arm's OUTPUT:
/// it resolves each seed's MBID (tier-1 via Last.fm's `artist.getinfo`, a
/// *different* endpoint than the arm's `artist.getsimilar`) and walks the LB
/// similarity graph off that MBID. Because the only shared input is the seed
/// list, the race is TOTAL — the LB 8s budget starts with the candidate phase
/// and overlaps Last.fm's similar-artist fan-out entirely (previously it began
/// only after Last.fm finished, so a cold-cache blend paid Last.fm latency PLUS
/// up to 8s LB, sequentially).
///
/// Contracts preserved by the race (see `race_arms`): Last.fm stays fail-CLOSED
/// (its error aborts the whole request AND drops the in-flight LB future — never
/// spawned, so cancellation leaks nothing beyond already-written, harmless cache
/// fills); LB stays fail-OPEN under its absolute budget (whatever it resolved is
/// blended, the rest skipped, `lb_degraded` unchanged in meaning); and the
/// merge is order-independent, so the blended result set is identical to the old
/// sequential version for any given pair of completed arm outputs — the race
/// changes WHEN work happens, never WHAT the blend contains.
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::{LastfmClient, is_transient_error};
use crate::listenbrainz::CandidateSource;
use crate::pipeline::BlendConfig;
use crate::utils::normalize_artist_name;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

const SIMILAR_CONCURRENCY: usize = 8;
const SIMILAR_ARTISTS_PER_SEED: u32 = 20;

/// Caps how many per-seed ListenBrainz futures run at once inside
/// `build_listenbrainz_prov_budgeted`. Each future's first step is
/// `resolve_mbid`, whose tier-1 lookup is a Last.fm `artist.getinfo` call —
/// on a cold cache (prod has no Redis, so every redeploy starts cold) pushing
/// all `MAX_SEEDS` (100) futures into `FuturesUnordered` unbounded would burst
/// up to 100 concurrent Last.fm requests at race start, stacking on top of the
/// Last.fm arm's own `SIMILAR_CONCURRENCY`-wide (8) `getsimilar` fan-out that
/// runs at the exact same moment (see `race_arms`). Mirrors `SIMILAR_CONCURRENCY`
/// so neither arm out-bursts the other. This only paces how fast seeds are
/// picked up — it does not touch the absolute 8s `LB_TIME_BUDGET`, so a
/// cold-cache request simply resolves fewer seeds within budget (already
/// handled by the existing fail-open/`degraded` path).
const LB_TIER1_CONCURRENCY: usize = 8;

/// Per-request wall-clock budget for the ADDITIVE ListenBrainz path. Whatever LB
/// resolves+fetches inside this window is blended; the rest is skipped and the
/// request is counted as degraded. This is the fail-open guarantee. The budget
/// starts when the candidate phase starts and runs CONCURRENTLY with the Last.fm
/// arm (see `race_arms`), so a blend request costs `max(lastfm, min(lb, 8s))` —
/// not the old `lastfm + min(lb, 8s)`. LB thus never adds latency on top of a
/// Last.fm arm that is at least as slow as LB itself.
const LB_TIME_BUDGET: Duration = Duration::from_secs(8);

/// Maps normalized_name → (display_name, list_of_recommending_seeds).
///
/// The normalized key prevents near-duplicates ("The Cure" / "the cure") from
/// appearing as separate candidates. The display_name preserves the canonical
/// casing for the API response.
pub type CandidateMap = HashMap<String, (String, Vec<String>)>;

// ── A6 candidate-seam contract: normalized keys + per-seed provenance ─────────

/// Which source(s) recommended a candidate off a given seed. Kept per (candidate,
/// seed) so blending can union sources WITHOUT double-counting a seed that both
/// sources agree on (the recommender count is what conviction scoring reads).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourceSet {
    pub lastfm: bool,
    pub listenbrainz: bool,
}

/// A provenance-carrying candidate: display name + the set of recommending seeds,
/// each tagged with which source(s) surfaced it off that seed. The public
/// `CandidateMap` that scoring consumes is derived from this (`prov_to_map`), so
/// the downstream pipeline stays candidate-source agnostic (no scoring change).
#[derive(Clone, Debug, Default)]
pub struct ProvCandidate {
    pub display: String,
    pub recs: HashMap<String, SourceSet>,
}

type ProvMap = HashMap<String, ProvCandidate>;

/// Flatten a provenance map to the `CandidateMap` scoring expects: `(display,
/// distinct recommending seeds)`. Because `recs` is keyed by seed, a candidate
/// found by both sources off the same seed contributes that seed exactly once.
fn prov_to_map(prov: ProvMap) -> CandidateMap {
    prov.into_iter()
        .map(|(norm, cand)| {
            let seeds: Vec<String> = cand.recs.into_keys().collect();
            (norm, (cand.display, seeds))
        })
        .collect()
}

/// Union two provenance maps (both keyed by the SAME `normalize_artist_name`).
/// `base` wins on display (Last.fm's canonical casing is preferred when both
/// sources carry the candidate); per-seed source flags are OR'd together.
fn merge_prov(mut base: ProvMap, other: ProvMap) -> ProvMap {
    for (norm, cand) in other {
        let entry = base.entry(norm).or_insert_with(|| ProvCandidate {
            display: cand.display.clone(),
            recs: HashMap::new(),
        });
        for (seed, sset) in cand.recs {
            let cur = entry.recs.entry(seed).or_default();
            cur.lastfm |= sset.lastfm;
            cur.listenbrainz |= sset.listenbrainz;
        }
    }
    base
}

/// Candidate-generation entry point used by the pipeline. `blend == None` or
/// `source == Lastfm` runs the original Last.fm-only `build` UNCHANGED
/// (byte-identical to today). Otherwise the ListenBrainz path is blended in.
pub async fn build_candidates(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
    blend: Option<&BlendConfig<'_>>,
) -> Result<CandidateMap, BoxError> {
    match blend {
        None => build(client, seed_names).await,
        Some(b) if b.source == CandidateSource::Lastfm => build(client, seed_names).await,
        Some(b) => build_blended(client, seed_names, b).await,
    }
}

/// Blend (or ListenBrainz-only) candidate generation. The two arms run
/// CONCURRENTLY (see `race_arms`). Last.fm stays FAIL-CLOSED (a transient failure
/// aborts the whole request via `?`, dropping the in-flight LB arm so the pool
/// stays deterministic); LB is FAIL-OPEN (budgeted, never `?`, degrades to what
/// it managed). Both arms operate on `seed_names`, which is fully known before
/// either starts — the LB arm consumes only the seeds, never the Last.fm arm's
/// output — so the LB 8s budget overlaps Last.fm's work rather than following it.
/// See `listenbrainz.rs` for the fail-open rationale.
async fn build_blended(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
    b: &BlendConfig<'_>,
) -> Result<CandidateMap, BoxError> {
    b.metrics.record_lb_request();

    // Last.fm arm — only for `blend`. `listenbrainz`-only has no Last.fm arm by
    // definition (it is the structurally-different graph on its own); its future
    // resolves to `None` immediately so the race just awaits the LB arm.
    let lastfm_fut = async {
        if b.source == CandidateSource::Blend {
            Ok(Some(build_lastfm_prov(client, seed_names).await?))
        } else {
            Ok(None)
        }
    };

    // ListenBrainz arm — additive, budgeted, fail-open. Constructed here but its
    // 8s deadline only starts when `race_arms` first polls it, i.e. concurrently
    // with the Last.fm arm above.
    let lb_fut = build_listenbrainz_prov(client, seed_names, b);

    let (lastfm_prov, lb_prov, degraded) = race_arms(lastfm_fut, lb_fut).await?;
    if degraded {
        b.metrics.record_lb_degraded();
    }

    let merged = match lastfm_prov {
        Some(lf) => merge_prov(lf, lb_prov),
        None => lb_prov,
    };
    let map = prov_to_map(merged);
    println!(
        "CANDIDATES[{}]: {} unique artists (lb_degraded={})",
        b.source.as_str(),
        map.len(),
        degraded
    );
    Ok(map)
}

/// Drive the fail-CLOSED Last.fm arm and the fail-OPEN, budgeted ListenBrainz arm
/// CONCURRENTLY, preserving every sequential contract:
///
/// * **Last.fm fail-closed.** If `lastfm_fut` errors, that error propagates via
///   `?` and `race_arms` returns immediately — the still-pending `lb_fut` is
///   DROPPED where it sits. Because the LB arm is a plain (never `tokio::spawn`ed)
///   future, dropping it cancels every in-flight LB request at its next await
///   point: nothing leaks and nothing writes beyond cache fills that had already
///   completed (which are harmless — see `listenbrainz.rs` caching notes).
/// * **ListenBrainz fail-open + absolute budget.** `lb_fut` never yields an error;
///   its own `timeout_at` deadline (started on first poll, i.e. at race start)
///   bounds it. On Last.fm SUCCESS the loop keeps polling until the LB arm hits
///   that deadline (or finishes early), so LB gets its full budget overlapped
///   with — not appended after — Last.fm's work.
/// * **Order independence.** The returned `(lastfm, lb, degraded)` triple is the
///   same regardless of which arm finishes first, so the caller's merge is
///   byte-for-byte identical to the old sequential version for equal arm outputs.
async fn race_arms<LF, LB>(
    lastfm_fut: LF,
    lb_fut: LB,
) -> Result<(Option<ProvMap>, ProvMap, bool), BoxError>
where
    LF: Future<Output = Result<Option<ProvMap>, BoxError>>,
    LB: Future<Output = (ProvMap, bool)>,
{
    tokio::pin!(lastfm_fut);
    tokio::pin!(lb_fut);

    let mut lastfm_done: Option<Option<ProvMap>> = None;
    let mut lb_done: Option<(ProvMap, bool)> = None;

    while lastfm_done.is_none() || lb_done.is_none() {
        tokio::select! {
            // Fail-closed: an error here returns from `race_arms`, dropping the
            // pinned `lb_fut` in place (cancels in-flight LB work, no leak).
            lf = &mut lastfm_fut, if lastfm_done.is_none() => {
                lastfm_done = Some(lf?);
            }
            // Fail-open: the LB arm self-bounds via its internal budget and never
            // errors, so we simply record whatever it resolved.
            lb = &mut lb_fut, if lb_done.is_none() => {
                lb_done = Some(lb);
            }
        }
    }

    let (lb_prov, degraded) = lb_done.unwrap();
    Ok((lastfm_done.unwrap(), lb_prov, degraded))
}

/// Last.fm candidate build, provenance-tagged. Structurally identical to `build`
/// (same fail-closed transient/permanent split) but records `lastfm` provenance
/// so blending can union sources per seed.
async fn build_lastfm_prov(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
) -> Result<ProvMap, BoxError> {
    let semaphore = Arc::new(Semaphore::new(SIMILAR_CONCURRENCY));
    let mut similar_futures = FuturesUnordered::new();
    for seed_name in seed_names {
        let client = Arc::clone(client);
        let seed_name = seed_name.clone();
        let semaphore = Arc::clone(&semaphore);
        similar_futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            let result = client.fetch_similar_artists(&seed_name, SIMILAR_ARTISTS_PER_SEED).await;
            (seed_name, result)
        }));
    }

    let mut prov: ProvMap = HashMap::new();
    while let Some(task_result) = similar_futures.next().await {
        match task_result {
            Ok((seed_name, Ok(similar_response))) => {
                for similar_artist in similar_response.similarartists.artist {
                    let norm_key = normalize_artist_name(&similar_artist.name);
                    let entry = prov.entry(norm_key).or_insert_with(|| ProvCandidate {
                        display: similar_artist.name.clone(),
                        recs: HashMap::new(),
                    });
                    entry.recs.entry(seed_name.clone()).or_default().lastfm = true;
                }
            }
            Ok((seed_name, Err(e))) => {
                if is_transient_error(e.as_ref()) {
                    return Err(format!("similar-artist fetch failed for seed '{}': {}", seed_name, e).into());
                }
                eprintln!("CANDIDATES: skipping seed '{}' (permanent error: {})", seed_name, e);
            }
            Err(e) => return Err(format!("similar-artist task failed: {}", e).into()),
        }
    }
    Ok(prov)
}

/// ListenBrainz candidate build, budgeted + fail-open. Drives all seeds
/// concurrently (network concurrency is bounded inside the LB client's
/// semaphores) and races the whole thing against an 8s deadline: whatever
/// completed is kept, the remainder is dropped, and `degraded` is set. Never
/// returns an error — an LB outage just yields fewer (or zero) blend candidates.
async fn build_listenbrainz_prov(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
    b: &BlendConfig<'_>,
) -> (ProvMap, bool) {
    build_listenbrainz_prov_budgeted(client, seed_names, b, LB_TIME_BUDGET).await
}

/// Budget-parameterized inner of `build_listenbrainz_prov` (the budget is a const
/// in production; tests inject a short one to exercise the fail-open deadline).
async fn build_listenbrainz_prov_budgeted(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
    b: &BlendConfig<'_>,
    budget: Duration,
) -> (ProvMap, bool) {
    let deadline = Instant::now() + budget;
    let lb = b.listenbrainz;
    let cache = b.cache;
    let metrics = b.metrics;

    let seed_semaphore = Arc::new(Semaphore::new(LB_TIER1_CONCURRENCY));
    let mut futures = FuturesUnordered::new();
    for seed in seed_names {
        let seed = seed.clone();
        let lastfm = Arc::clone(client);
        let seed_semaphore = Arc::clone(&seed_semaphore);
        futures.push(async move {
            // Held for the whole per-seed future (tier-1 resolve through
            // similar-artist fetch) so the semaphore caps concurrent entries
            // into `resolve_mbid` — see `LB_TIER1_CONCURRENCY`.
            let _permit = seed_semaphore.acquire().await;
            let neighbors = match lb.resolve_mbid(&seed, &lastfm, cache, metrics).await {
                Some(mbid) => {
                    lb.similar(&mbid, SIMILAR_ARTISTS_PER_SEED as usize, cache, metrics).await
                }
                None => Vec::new(),
            };
            (seed, neighbors)
        });
    }

    let mut prov: ProvMap = HashMap::new();
    let mut degraded = false;
    loop {
        match tokio::time::timeout_at(deadline.into(), futures.next()).await {
            Ok(Some((seed, neighbors))) => {
                for (cand_name, _match) in neighbors {
                    let norm_key = normalize_artist_name(&cand_name);
                    let entry = prov.entry(norm_key).or_insert_with(|| ProvCandidate {
                        display: cand_name.clone(),
                        recs: HashMap::new(),
                    });
                    entry.recs.entry(seed.clone()).or_default().listenbrainz = true;
                }
            }
            Ok(None) => break,          // all seeds finished within budget
            Err(_elapsed) => {          // 8s budget hit — keep the partial blend
                degraded = true;
                break;
            }
        }
    }
    (prov, degraded)
}

pub async fn build(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
) -> Result<CandidateMap, BoxError> {
    let semaphore = Arc::new(Semaphore::new(SIMILAR_CONCURRENCY));
    let mut similar_futures = FuturesUnordered::new();

    for seed_name in seed_names {
        let client = Arc::clone(client);
        let seed_name = seed_name.clone();
        let semaphore = Arc::clone(&semaphore);
        similar_futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            // Small jitter to avoid thundering herd on the Last.fm API
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            let result = client.fetch_similar_artists(&seed_name, SIMILAR_ARTISTS_PER_SEED).await;
            (seed_name, result)
        }));
    }

    let mut candidate_map: CandidateMap = HashMap::new();
    while let Some(task_result) = similar_futures.next().await {
        match task_result {
            Ok((seed_name, Ok(similar_response))) => {
                for similar_artist in similar_response.similarartists.artist {
                    let norm_key = normalize_artist_name(&similar_artist.name);
                    let entry = candidate_map
                        .entry(norm_key)
                        .or_insert_with(|| (similar_artist.name.clone(), Vec::new()));
                    entry.1.push(seed_name.clone());
                }
            }
            // A transient failure (rate-limit/5xx/network past retries) means the
            // candidate pool would be incomplete — fail the whole request so we never
            // ship or cache a non-deterministic partial result. A permanent failure
            // (a seed Last.fm can't expand) is deterministic, so skip just that seed.
            Ok((seed_name, Err(e))) => {
                if is_transient_error(e.as_ref()) {
                    return Err(format!("similar-artist fetch failed for seed '{}': {}", seed_name, e).into());
                }
                eprintln!("CANDIDATES: skipping seed '{}' (permanent error: {})", seed_name, e);
            }
            Err(e) => return Err(format!("similar-artist task failed: {}", e).into()),
        }
    }

    println!("CANDIDATES: {} unique artists found", candidate_map.len());
    Ok(candidate_map)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a single-source provenance map from `(display, [seeds])` rows,
    /// keyed by `normalize_artist_name` exactly like the real providers.
    fn prov_from(rows: &[(&str, &[&str])], source: fn(&mut SourceSet)) -> ProvMap {
        let mut m: ProvMap = HashMap::new();
        for (display, seeds) in rows {
            let entry = m.entry(normalize_artist_name(display)).or_insert_with(|| ProvCandidate {
                display: display.to_string(),
                recs: HashMap::new(),
            });
            for s in *seeds {
                source(entry.recs.entry(s.to_string()).or_default());
            }
        }
        m
    }

    fn lf(s: &mut SourceSet) { s.lastfm = true; }
    fn lb(s: &mut SourceSet) { s.listenbrainz = true; }

    // A6 contract: colliding display names ("The Cure" / "the cure" / "The Cure ")
    // across sources collapse to ONE candidate under the shared normalize key.
    #[test]
    fn blend_dedups_colliding_names_across_sources() {
        let lastfm = prov_from(&[("The Cure", &["Siouxsie"])], lf);
        let listenbrainz = prov_from(&[("the cure", &["Bauhaus"]), ("The Cure ", &["Joy Division"])], lb);

        let merged = merge_prov(lastfm, listenbrainz);
        // All three spellings normalize to the same key → exactly one entry.
        assert_eq!(merged.len(), 1, "colliding names must collapse to one candidate");

        let map = prov_to_map(merged);
        let (norm, (display, mut seeds)) = map.into_iter().next().unwrap();
        assert_eq!(norm, "cure");
        // Last.fm's canonical casing wins the display.
        assert_eq!(display, "The Cure");
        seeds.sort();
        assert_eq!(seeds, vec!["Bauhaus", "Joy Division", "Siouxsie"]);
    }

    // A candidate found by BOTH sources off the SAME seed counts that seed once
    // (no double-counted recommender → no inflated conviction).
    #[test]
    fn blend_no_double_count_on_shared_seed() {
        let lastfm = prov_from(&[("Slint", &["Shellac", "Bitch Magnet"])], lf);
        let listenbrainz = prov_from(&[("Slint", &["Shellac", "Rodan"])], lb);

        let merged = merge_prov(lastfm, listenbrainz);
        let entry = merged.get("slint").expect("candidate present");
        // Shellac was recommended by both sources — still ONE recommender entry,
        // but its provenance records both sources.
        let shellac = entry.recs.get("Shellac").expect("shared seed present");
        assert!(shellac.lastfm && shellac.listenbrainz, "shared seed keeps both sources");
        // Distinct recommenders = union, not sum: {Shellac, Bitch Magnet, Rodan}.
        assert_eq!(entry.recs.len(), 3);

        let map = prov_to_map(merged);
        let (_display, seeds) = map.get("slint").unwrap();
        assert_eq!(seeds.len(), 3, "shared seed counted once, not twice");
    }

    // LB-only candidates (not surfaced by Last.fm) are additive — they join the
    // pool with listenbrainz provenance.
    #[test]
    fn blend_adds_listenbrainz_only_candidates() {
        let lastfm = prov_from(&[("Duster", &["Bedhead"])], lf);
        let listenbrainz = prov_from(&[("Duster", &["Bedhead"]), ("Flying Saucer Attack", &["Bedhead"])], lb);

        let merged = merge_prov(lastfm, listenbrainz);
        assert_eq!(merged.len(), 2, "LB-only candidate is added");
        let fsa = merged.get("flying saucer attack").unwrap();
        assert!(fsa.recs.get("Bedhead").unwrap().listenbrainz);
        assert!(!fsa.recs.get("Bedhead").unwrap().lastfm);
    }

    // prov_to_map yields the exact CandidateMap shape scoring consumes.
    #[test]
    fn prov_to_map_shape_matches_candidate_map() {
        let prov = prov_from(&[("Codeine", &["Low", "Bedhead"])], lf);
        let map = prov_to_map(prov);
        let (display, seeds) = map.get("codeine").unwrap();
        assert_eq!(display, "Codeine");
        assert_eq!(seeds.len(), 2);
    }

    // ── Budget / fail-open tests for the ListenBrainz arm (mock LB server) ────

    use crate::cache::{CacheStore, InMemoryStore};
    use crate::listenbrainz::ListenBrainzClient;
    use crate::metrics::Metrics;
    use crate::pipeline::BlendConfig;
    use axum::{extract::Query, routing::get, Json, Router};

    /// Spin a similar-artists mock that optionally sleeps `delay_ms` before
    /// answering (to force the fail-open time budget to trip).
    async fn spawn_lb_similar_mock(delay_ms: u64) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/",
            get(move |Query(_q): Query<std::collections::HashMap<String, String>>| async move {
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                Json(serde_json::json!([
                    { "name": "MockNeighbour", "score": 10 },
                ]))
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        format!("http://{}/", addr)
    }

    /// Seed the mbid cache so `resolve_mbid` short-circuits tier-1 (no Last.fm
    /// call in the test) — each seed resolves to a fixed mbid straight from cache.
    async fn preseed_mbids(cache: &CacheStore, seeds: &[&str]) {
        for s in seeds {
            let key = format!("lb:mbid:{}", normalize_artist_name(s));
            cache
                .put_json(&key, &serde_json::json!({ "mbid": format!("mbid-{}", s) }), Duration::from_secs(3600))
                .await;
        }
    }

    // Fail-open: a slow LB (500ms) under a tiny 100ms budget yields NO blend
    // candidates, is flagged degraded, and — critically — returns fast.
    #[tokio::test]
    async fn lb_arm_fails_open_on_budget_timeout() {
        let url = spawn_lb_similar_mock(500).await;
        let lb = ListenBrainzClient::with_urls(url, "unused".into());
        let cache = CacheStore::InMemory(InMemoryStore::new());
        let metrics = Metrics::new();
        preseed_mbids(&cache, &["SeedA", "SeedB"]).await;

        let b = BlendConfig {
            source: CandidateSource::Blend,
            listenbrainz: &lb,
            cache: &cache,
            metrics: &metrics,
        };
        let dummy_lastfm = Arc::new(LastfmClient::new("TESTKEY".into()));
        let seeds = vec!["SeedA".to_string(), "SeedB".to_string()];

        let start = Instant::now();
        let (prov, degraded) =
            build_listenbrainz_prov_budgeted(&dummy_lastfm, &seeds, &b, Duration::from_millis(100)).await;
        let elapsed = start.elapsed();

        assert!(degraded, "LB exceeding the budget must be flagged degraded");
        assert!(prov.is_empty(), "nothing completed within the 100ms budget");
        assert!(
            elapsed < Duration::from_millis(400),
            "fail-open must return near the budget, not wait for slow LB (took {:?})",
            elapsed
        );
    }

    // Happy path: a fast LB within budget blends its candidates and is NOT
    // degraded; the mbid cache short-circuits Last.fm entirely.
    #[tokio::test]
    async fn lb_arm_blends_within_budget() {
        let url = spawn_lb_similar_mock(0).await;
        let lb = ListenBrainzClient::with_urls(url, "unused".into());
        let cache = CacheStore::InMemory(InMemoryStore::new());
        let metrics = Metrics::new();
        preseed_mbids(&cache, &["SeedA"]).await;

        let b = BlendConfig {
            source: CandidateSource::Blend,
            listenbrainz: &lb,
            cache: &cache,
            metrics: &metrics,
        };
        let dummy_lastfm = Arc::new(LastfmClient::new("TESTKEY".into()));
        let seeds = vec!["SeedA".to_string()];

        let (prov, degraded) =
            build_listenbrainz_prov_budgeted(&dummy_lastfm, &seeds, &b, Duration::from_secs(5)).await;

        assert!(!degraded, "fast LB within budget is not degraded");
        let cand = prov.get("mockneighbour").expect("LB candidate blended in");
        assert!(cand.recs.get("SeedA").unwrap().listenbrainz);
    }

    // Regression for the LB_TIER1_CONCURRENCY cap (FIX 1): pushing more seeds
    // than the cap must still resolve every seed within a generous budget —
    // the semaphore should only pace intake, never drop or deadlock work.
    // (A true peak-concurrency assertion on the tier-1 `resolve_mbid` fan-out
    // would need to mock Last.fm's `artist.getinfo`, which `fetch_artist_mbid`
    // hits via the hardcoded `LASTFM_API_URL` — not the `LASTFM_API_BASE`
    // override used elsewhere — so it isn't cheaply mockable without touching
    // lastfm.rs production code; this test instead guards the queuing
    // behavior via the already-mockable `similar` seam.)
    #[tokio::test]
    async fn lb_arm_resolves_all_seeds_above_concurrency_cap() {
        let url = spawn_lb_similar_mock(0).await;
        let lb = ListenBrainzClient::with_urls(url, "unused".into());
        let cache = CacheStore::InMemory(InMemoryStore::new());
        let metrics = Metrics::new();
        let seed_names: Vec<String> = (0..12).map(|i| format!("Seed{}", i)).collect();
        let seed_refs: Vec<&str> = seed_names.iter().map(String::as_str).collect();
        preseed_mbids(&cache, &seed_refs).await;

        let b = BlendConfig {
            source: CandidateSource::Blend,
            listenbrainz: &lb,
            cache: &cache,
            metrics: &metrics,
        };
        let dummy_lastfm = Arc::new(LastfmClient::new("TESTKEY".into()));

        let (prov, degraded) =
            build_listenbrainz_prov_budgeted(&dummy_lastfm, &seed_names, &b, Duration::from_secs(5)).await;

        assert!(!degraded, "12 seeds queued behind an 8-wide cap must still finish within a generous budget");
        let cand = prov.get("mockneighbour").expect("LB candidate blended in");
        assert_eq!(cand.recs.len(), 12, "every seed must be resolved, not just the first 8");
    }

    // ── race_arms: concurrency + fail-closed abort + fail-open budget ─────────

    // Concurrency: two ~300ms arms run at the same time, so the race finishes in
    // ~300ms — comfortably under the 500ms bound and well under the 600ms the old
    // sequential (Last.fm THEN LB) design would have cost. Generous margin so a
    // loaded CI box doesn't flake.
    #[tokio::test]
    async fn race_arms_runs_arms_concurrently() {
        let lf = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Ok(Some(prov_from(&[("LfCand", &["SeedA"])], lf)))
        };
        let lb = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            (prov_from(&[("LbCand", &["SeedA"])], lb), false)
        };

        let start = Instant::now();
        let (lastfm_prov, lb_prov, degraded) = race_arms(lf, lb).await.unwrap();
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_millis(500),
            "arms must overlap (concurrent ~300ms, not sequential ~600ms); took {:?}",
            elapsed
        );
        assert!(!degraded);
        assert!(lastfm_prov.unwrap().contains_key("lfcand"));
        assert!(lb_prov.contains_key("lbcand"));
    }

    // Fail-closed: a Last.fm-arm error propagates AND the in-flight LB future is
    // dropped where it sits — the race returns near the failure time, never
    // waiting out the (here 5s) LB arm, and never panics or hangs.
    #[tokio::test]
    async fn race_arms_lastfm_failure_aborts_lb_in_flight() {
        let lf = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Err::<Option<ProvMap>, BoxError>("similar-artist fetch failed for seed 'X': boom".into())
        };
        // If this future were awaited to completion the test would take 5s; the
        // abort must drop it long before then.
        let lb = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            (prov_from(&[("Never", &["SeedA"])], lb), false)
        };

        let start = Instant::now();
        let result = race_arms(lf, lb).await;
        let elapsed = start.elapsed();

        assert!(result.is_err(), "Last.fm-arm error must fail the whole request");
        assert!(
            elapsed < Duration::from_secs(1),
            "LB in flight must be dropped on Last.fm failure, not awaited (took {:?})",
            elapsed
        );
    }

    // Fail-open during overlap: the REAL budgeted LB arm (slow 500ms mock under a
    // 100ms budget) races a fast, successful Last.fm arm. The request succeeds
    // with the Last.fm candidates, LB is degraded, and nothing LB resolved in the
    // 100ms window is blended.
    #[tokio::test]
    async fn race_lb_budget_expiry_during_overlap() {
        let url = spawn_lb_similar_mock(500).await;
        let lb = ListenBrainzClient::with_urls(url, "unused".into());
        let cache = CacheStore::InMemory(InMemoryStore::new());
        let metrics = Metrics::new();
        preseed_mbids(&cache, &["SeedA"]).await;

        let b = BlendConfig {
            source: CandidateSource::Blend,
            listenbrainz: &lb,
            cache: &cache,
            metrics: &metrics,
        };
        let dummy_lastfm = Arc::new(LastfmClient::new("TESTKEY".into()));
        let seeds = vec!["SeedA".to_string()];

        let lf = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(Some(prov_from(&[("LfCand", &["SeedA"])], lf)))
        };
        let lb_fut = build_listenbrainz_prov_budgeted(&dummy_lastfm, &seeds, &b, Duration::from_millis(100));

        let (lastfm_prov, lb_prov, degraded) = race_arms(lf, lb_fut).await.unwrap();

        assert!(degraded, "slow LB past its budget must be degraded");
        assert!(lb_prov.is_empty(), "nothing LB resolved within the 100ms budget");
        let merged = merge_prov(lastfm_prov.unwrap(), lb_prov);
        let map = prov_to_map(merged);
        assert!(map.contains_key("lfcand"), "Last.fm candidates survive an LB degrade");
    }

    // Determinism: identical arm outputs produce an identical CandidateMap no
    // matter which arm finishes first. Run once with Last.fm slower, once with LB
    // slower (both within budget), and assert the merged maps match exactly.
    #[tokio::test]
    async fn race_arms_determinism_regardless_of_order() {
        async fn run(lf_delay: u64, lb_delay: u64) -> CandidateMap {
            let lf = async move {
                tokio::time::sleep(Duration::from_millis(lf_delay)).await;
                Ok(Some(prov_from(&[("Shared", &["SeedA"]), ("LfOnly", &["SeedA"])], lf)))
            };
            let lb = async move {
                tokio::time::sleep(Duration::from_millis(lb_delay)).await;
                (prov_from(&[("Shared", &["SeedA"]), ("LbOnly", &["SeedB"])], lb), false)
            };
            let (lastfm_prov, lb_prov, _degraded) = race_arms(lf, lb).await.unwrap();
            let merged = match lastfm_prov {
                Some(lf) => merge_prov(lf, lb_prov),
                None => lb_prov,
            };
            prov_to_map(merged)
        }

        // Order A: Last.fm finishes last. Order B: LB finishes last.
        let a = run(200, 20).await;
        let b = run(20, 200).await;

        // Same key set.
        let mut ka: Vec<_> = a.keys().cloned().collect();
        let mut kb: Vec<_> = b.keys().cloned().collect();
        ka.sort();
        kb.sort();
        assert_eq!(ka, kb, "candidate key set must be order-independent");
        // Same per-candidate recommender sets (sorted).
        for key in &ka {
            let mut sa = a[key].1.clone();
            let mut sb = b[key].1.clone();
            sa.sort();
            sb.sort();
            assert_eq!(sa, sb, "recommenders for '{}' must be order-independent", key);
            assert_eq!(a[key].0, b[key].0, "display for '{}' must be order-independent", key);
        }
    }
}
