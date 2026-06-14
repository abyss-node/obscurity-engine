/// Phase 2: expand seeds into discovery candidates via similar-artist traversal.
///
/// For each seed artist, fetches Last.fm's "similar artists" list. Candidates
/// that show up via multiple seeds accumulate more recommenders — this is the
/// raw input for conviction scoring in Phase 3.
///
/// The semaphore prevents thundering-herd against the Last.fm API.
use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::{LastfmClient, is_transient_error};
use crate::utils::normalize_artist_name;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

const SIMILAR_CONCURRENCY: usize = 8;
const SIMILAR_ARTISTS_PER_SEED: u32 = 20;

/// Maps normalized_name → (display_name, list_of_recommending_seeds).
///
/// The normalized key prevents near-duplicates ("The Cure" / "the cure") from
/// appearing as separate candidates. The display_name preserves the canonical
/// casing for the API response.
pub type CandidateMap = HashMap<String, (String, Vec<String>)>;

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
