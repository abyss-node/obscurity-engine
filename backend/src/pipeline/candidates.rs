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
use crate::lastfm::LastfmClient;
use crate::utils::normalize_artist_name;

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
) -> CandidateMap {
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
        if let Ok((seed_name, Ok(similar_response))) = task_result {
            for similar_artist in similar_response.similarartists.artist {
                let norm_key = normalize_artist_name(&similar_artist.name);
                let entry = candidate_map
                    .entry(norm_key)
                    .or_insert_with(|| (similar_artist.name.clone(), Vec::new()));
                entry.1.push(seed_name.clone());
            }
        }
    }

    println!("CANDIDATES: {} unique artists found", candidate_map.len());
    candidate_map
}
