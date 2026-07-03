/// Phase 2: expand seeds into discovery candidates via similar-artist traversal.
///
/// For each seed artist, fetches Last.fm's "similar artists" list. Candidates
/// that show up via multiple seeds accumulate more recommenders — this is the
/// raw input for conviction scoring in Phase 3.
///
/// The semaphore prevents thundering-herd against the Last.fm API.
use std::collections::HashMap;
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

/// Per-request wall-clock budget for the ADDITIVE ListenBrainz path. Whatever LB
/// resolves+fetches inside this window is blended; the rest is skipped and the
/// request is counted as degraded. This is the fail-open guarantee: LB never
/// meaningfully delays a discovery (Last.fm alone always answers first).
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

/// Blend (or ListenBrainz-only) candidate generation. Last.fm stays FAIL-CLOSED
/// (a transient failure aborts via `?` so the pool stays deterministic); LB is
/// FAIL-OPEN (budgeted, never `?`, degrades to what it managed). See
/// `listenbrainz.rs` for the fail-open rationale.
async fn build_blended(
    client: &Arc<LastfmClient>,
    seed_names: &[String],
    b: &BlendConfig<'_>,
) -> Result<CandidateMap, BoxError> {
    b.metrics.record_lb_request();

    // Last.fm arm — only for `blend`. `listenbrainz`-only has no Last.fm arm by
    // definition (it is the structurally-different graph on its own).
    let lastfm_prov = if b.source == CandidateSource::Blend {
        Some(build_lastfm_prov(client, seed_names).await?)
    } else {
        None
    };

    // ListenBrainz arm — additive, budgeted, fail-open.
    let (lb_prov, degraded) = build_listenbrainz_prov(client, seed_names, b).await;
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
    let deadline = Instant::now() + LB_TIME_BUDGET;
    let lb = b.listenbrainz;
    let cache = b.cache;
    let metrics = b.metrics;

    let mut futures = FuturesUnordered::new();
    for seed in seed_names {
        let seed = seed.clone();
        let lastfm = Arc::clone(client);
        futures.push(async move {
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
}
