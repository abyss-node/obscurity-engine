/// Phase 2 (track mode): build candidates via Spotify recommendations.
///
/// 1. Search each seed track on Spotify to get a track ID.
/// 2. Group IDs into batches of 5 (Spotify's max seeds per recommendations call).
/// 3. Call /recommendations for each batch — tracks that appear across multiple
///    batches accumulate higher batch_appearances, used as conviction signal.
use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::spotify::SpotifyClient;
use super::track_seeds::seed_key;

const SEARCH_CONCURRENCY: usize = 5;
const RECS_PER_BATCH: u32 = 50;
/// Spotify popularity ceiling (0–100). 60 = no mainstream hits.
const MAX_POPULARITY: u32 = 60;
const BATCH_SIZE: usize = 5;
const MAX_SEEDS_TO_SEARCH: usize = 20;

/// Maps candidate_key → (artist, track_name, batch_appearances, spotify_popularity)
pub type TrackCandidateMap = HashMap<String, (String, String, usize, u32)>;

pub async fn build(
    spotify: &Arc<SpotifyClient>,
    seeds: &[(String, String)],
) -> (TrackCandidateMap, usize) {
    // Step 1: search each seed on Spotify to get IDs
    let semaphore = Arc::new(Semaphore::new(SEARCH_CONCURRENCY));
    let mut search_futures = FuturesUnordered::new();

    for (artist, track) in seeds.iter().take(MAX_SEEDS_TO_SEARCH) {
        let spotify = Arc::clone(spotify);
        let artist = artist.clone();
        let track = track.clone();
        let semaphore = Arc::clone(&semaphore);
        search_futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            spotify.search_track(&artist, &track).await
        }));
    }

    let mut spotify_ids: Vec<String> = Vec::new();
    while let Some(result) = search_futures.next().await {
        if let Ok(Some(id)) = result {
            spotify_ids.push(id);
        }
    }

    if spotify_ids.is_empty() {
        println!("TRACK_CANDIDATES: 0 Spotify IDs matched from seeds");
        return (HashMap::new(), 0);
    }

    // Step 2: batch IDs, call recommendations for each batch
    let batches: Vec<Vec<String>> = spotify_ids
        .chunks(BATCH_SIZE)
        .map(|c| c.to_vec())
        .collect();
    let total_batches = batches.len();

    let mut rec_futures = FuturesUnordered::new();
    for batch in batches {
        let spotify = Arc::clone(spotify);
        rec_futures.push(tokio::spawn(async move {
            spotify.get_recommendations(&batch, RECS_PER_BATCH, MAX_POPULARITY).await
        }));
    }

    let mut candidate_map: TrackCandidateMap = HashMap::new();
    while let Some(result) = rec_futures.next().await {
        if let Ok(recs) = result {
            for track in recs {
                let artist = track.artist_name().to_string();
                let key = seed_key(&artist, &track.name);
                let entry = candidate_map
                    .entry(key)
                    .or_insert_with(|| (artist, track.name.clone(), 0, track.popularity));
                entry.2 += 1;
            }
        }
    }

    println!(
        "TRACK_CANDIDATES: {} unique tracks from {} Spotify batches ({} seeds matched)",
        candidate_map.len(), total_batches, spotify_ids.len()
    );
    (candidate_map, total_batches)
}
