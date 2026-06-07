/// Phase 2 (track mode): expand seed tracks into candidates via track.getSimilar.
use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::LastfmClient;
use super::track_seeds::seed_key;

const SIMILAR_CONCURRENCY: usize = 6;
const SIMILAR_TRACKS_PER_SEED: u32 = 15;

/// Maps candidate_key → (artist, track_name, Vec<seed_key_that_recommended_it>)
pub type TrackCandidateMap = HashMap<String, (String, String, Vec<String>)>;

pub async fn build(
    client: &Arc<LastfmClient>,
    seeds: &[(String, String)],
) -> TrackCandidateMap {
    let semaphore = Arc::new(Semaphore::new(SIMILAR_CONCURRENCY));
    let mut futures = FuturesUnordered::new();

    for (artist, track) in seeds {
        let client = Arc::clone(client);
        let artist = artist.clone();
        let track = track.clone();
        let semaphore = Arc::clone(&semaphore);
        futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            tokio::time::sleep(tokio::time::Duration::from_millis(60)).await;
            let result = client.fetch_similar_tracks(&artist, &track, SIMILAR_TRACKS_PER_SEED).await;
            (artist, track, result)
        }));
    }

    let mut candidate_map: TrackCandidateMap = HashMap::new();
    while let Some(task_result) = futures.next().await {
        if let Ok((seed_artist, seed_track, Ok(similar_response))) = task_result {
            let seed_k = seed_key(&seed_artist, &seed_track);
            for similar in similar_response.similartracks.track {
                let key = seed_key(&similar.artist.name, &similar.name);
                let entry = candidate_map
                    .entry(key)
                    .or_insert_with(|| (similar.artist.name.clone(), similar.name.clone(), Vec::new()));
                entry.2.push(seed_k.clone());
            }
        }
    }

    println!("TRACK_CANDIDATES: {} unique tracks found", candidate_map.len());
    candidate_map
}
