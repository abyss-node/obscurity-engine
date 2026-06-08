/// Phase 2 (track mode): build candidates via Last.fm similar-artist expansion.
///
/// Algorithm:
///   1. Deduplicate seed artists (up to MAX_SEED_ARTISTS).
///   2. For each seed artist, call artist.getsimilar.
///   3. Tally: how many seed artists each similar artist was returned by.
///      This count becomes the conviction numerator.
///   4. Sort similar artists by tally (desc), take top MAX_SIMILAR_TO_EXPAND.
///   5. For each, call artist.gettoptracks to collect candidate tracks.
///
/// Returns (TrackCandidateMap, total_seed_artists).
/// conviction_score in the map = raw tally count; divide by total_seed_artists
/// in scoring to normalise 0-1.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::LastfmClient;
use crate::utils::normalize_artist_name;
use super::track_seeds::{seed_key, TrackSeeds};

const SIMILAR_CONCURRENCY: usize = 8;
const TRACKS_CONCURRENCY: usize = 8;
const SIMILAR_LIMIT: u32 = 50;
const TOP_TRACKS_PER_ARTIST: u32 = 10;
const MAX_SEED_ARTISTS: usize = 50;
const MAX_SIMILAR_TO_EXPAND: usize = 100;

/// Maps candidate_key → (artist, track_name, seed_artist_count, 0u32)
/// The 4th field is unused; kept as u32 to match the scoring layer's type.
pub type TrackCandidateMap = HashMap<String, (String, String, usize, u32)>;

pub async fn build(
    client: &Arc<LastfmClient>,
    seeds: &TrackSeeds,
) -> (TrackCandidateMap, usize) {
    // Deduplicate seed artists by normalised name
    let mut seen: HashSet<String> = HashSet::new();
    let mut seed_artists: Vec<String> = Vec::new();
    for (artist, _) in &seeds.entries {
        if seen.insert(normalize_artist_name(artist)) {
            seed_artists.push(artist.clone());
            if seed_artists.len() >= MAX_SEED_ARTISTS {
                break;
            }
        }
    }

    let total_seed_artists = seed_artists.len();
    let seed_norm_set: HashSet<String> = seed_artists.iter().map(|a| normalize_artist_name(a)).collect();

    println!("TRACK_CANDIDATES: {} unique seed artists", total_seed_artists);

    // Phase 1: fetch similar artists for each seed artist in parallel
    let sem1 = Arc::new(Semaphore::new(SIMILAR_CONCURRENCY));
    let mut similar_futs: FuturesUnordered<_> = seed_artists
        .iter()
        .map(|artist| {
            let client = Arc::clone(client);
            let artist = artist.clone();
            let sem = Arc::clone(&sem1);
            tokio::spawn(async move {
                let _permit = sem.acquire().await;
                let result = client.fetch_similar_artists(&artist, SIMILAR_LIMIT).await;
                (artist, result)
            })
        })
        .collect();

    // Tally: normalised_name → (display_name, count)
    let mut tally: HashMap<String, (String, usize)> = HashMap::new();
    while let Some(task) = similar_futs.next().await {
        if let Ok((_, Ok(resp))) = task {
            for sim in resp.similarartists.artist {
                let norm = normalize_artist_name(&sim.name);
                if seed_norm_set.contains(&norm) {
                    continue; // skip artists the user already knows
                }
                let entry = tally.entry(norm).or_insert_with(|| (sim.name.clone(), 0));
                entry.1 += 1;
            }
        }
    }

    // Sort by tally desc, take top N
    let mut ranked: Vec<(String, usize)> = tally.into_values().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked.truncate(MAX_SIMILAR_TO_EXPAND);

    println!("TRACK_CANDIDATES: {} similar artists to expand", ranked.len());

    // Phase 2: fetch top tracks for each similar artist in parallel
    let sem2 = Arc::new(Semaphore::new(TRACKS_CONCURRENCY));
    let mut track_futs: FuturesUnordered<_> = ranked
        .into_iter()
        .map(|(display_name, conviction_count)| {
            let client = Arc::clone(client);
            let sem = Arc::clone(&sem2);
            tokio::spawn(async move {
                let _permit = sem.acquire().await;
                let result = client.fetch_artist_top_tracks(&display_name, TOP_TRACKS_PER_ARTIST).await;
                (display_name, conviction_count, result)
            })
        })
        .collect();

    let mut candidate_map: TrackCandidateMap = HashMap::new();
    while let Some(task) = track_futs.next().await {
        if let Ok((artist, conviction_count, Ok(resp))) = task {
            for track in resp.toptracks.track {
                let key = seed_key(&artist, &track.name);
                candidate_map
                    .entry(key)
                    .or_insert_with(|| (artist.clone(), track.name.clone(), conviction_count, 0u32));
            }
        }
    }

    println!(
        "TRACK_CANDIDATES: {} unique tracks from {} seed artists",
        candidate_map.len(),
        total_seed_artists
    );
    (candidate_map, total_seed_artists)
}
