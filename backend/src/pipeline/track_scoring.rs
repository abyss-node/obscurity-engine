/// Phase 3 (track mode): score, filter, and rank Last.fm track candidates.
///
/// Scoring formula:
///   conviction  = seed_artist_count / total_seed_artists  (0–1)
///                 How many of the user's seed artists independently surfaced
///                 this track's artist via similar-artist expansion.
///   stickiness  = lastfm_playcount / lastfm_listeners     (repeat-listen ratio)
///   composite   = conviction × stickiness × 10_000
///
/// Filters (via track.getInfo):
///   - user already plays this track (userplaycount > 0) → skip
///   - listener count > MAX_LISTENER_CEILING → skip (too mainstream)

use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::LastfmClient;
use crate::models::{GenreWeight, TrackDiscoveryItem, TrackDiscoveryResponse};
use super::track_candidates::TrackCandidateMap;
use super::track_seeds::TrackSeeds;

const INFO_CONCURRENCY: usize = 10;
const MAX_LISTENER_CEILING: u64 = 50_000;
const DIVERSITY_SLOTS_PER_GENRE: usize = 3;
const MAX_CANDIDATES_FOR_INFO_FETCH: usize = 300;
const MAX_RESULTS: usize = 30;

async fn build_seed_tag_profile(
    client: &Arc<LastfmClient>,
    seeds: &TrackSeeds,
) -> HashMap<String, f64> {
    use super::track_seeds::seed_key;
    const TOP_SEEDS: usize = 20;

    // Aggregate per-artist weight from track seed weights
    let mut artist_weights: HashMap<String, f64> = HashMap::new();
    for (artist, track) in &seeds.entries {
        let key = seed_key(artist, track);
        let w = seeds.weights.get(&key).copied().unwrap_or(1.0);
        *artist_weights.entry(artist.clone()).or_insert(0.0) += w;
    }

    let mut sorted: Vec<_> = artist_weights.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(TOP_SEEDS);
    let total: f64 = sorted.iter().map(|(_, w)| w).sum::<f64>().max(1.0);

    let sem = Arc::new(Semaphore::new(8));
    let mut futs: FuturesUnordered<_> = sorted.into_iter().map(|(artist, weight)| {
        let client = Arc::clone(client);
        let sem = Arc::clone(&sem);
        tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let tags = client.fetch_artist_tags(&artist).await;
            (tags, weight)
        })
    }).collect();

    let mut profile: HashMap<String, f64> = HashMap::new();
    while let Some(task) = futs.next().await {
        if let Ok((tags, weight)) = task {
            let share = weight / total;
            for tag in tags.iter().take(3) {
                *profile.entry(tag.to_lowercase()).or_insert(0.0) += share;
            }
        }
    }
    println!("TRACK_SEED_TAGS: profile with {} unique tags", profile.len());
    profile
}

pub async fn score_and_rank(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: TrackCandidateMap,
    total_seed_artists: usize,
    seeds: &TrackSeeds,
) -> Result<TrackDiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let candidate_map = if candidate_map.len() > MAX_CANDIDATES_FOR_INFO_FETCH {
        let mut ranked: Vec<_> = candidate_map.into_iter().collect();
        ranked.sort_by(|a, b| b.1.2.cmp(&a.1.2));
        ranked.truncate(MAX_CANDIDATES_FOR_INFO_FETCH);
        println!("TRACK_SCORING: capped to {} candidates (was more)", MAX_CANDIDATES_FOR_INFO_FETCH);
        ranked.into_iter().collect()
    } else {
        candidate_map
    };

    let semaphore = Arc::new(Semaphore::new(INFO_CONCURRENCY));
    let mut futures: FuturesUnordered<_> = candidate_map
        .into_iter()
        .map(|(_key, (artist, track, seed_artist_count, artist_tags))| {
            let client = Arc::clone(client);
            let username = username.to_string();
            let sem = Arc::clone(&semaphore);
            tokio::spawn(async move {
                let _permit = sem.acquire().await;
                let info = client.fetch_track_info(&artist, &track, &username).await;
                (artist, track, seed_artist_count, artist_tags, info)
            })
        })
        .collect();

    let mut scored: Vec<TrackDiscoveryItem> = Vec::new();
    while let Some(result) = futures.next().await {
        if let Ok((artist, track_name, seed_artist_count, artist_tags, Ok(info_resp))) = result {
            if let Some(item) = score_candidate(
                info_resp.track,
                artist,
                track_name,
                seed_artist_count,
                total_seed_artists,
                artist_tags,
            ) {
                scored.push(item);
            }
        }
    }

    scored.sort_by(|a, b| {
        b.composite_score
            .partial_cmp(&a.composite_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let seed_tag_profile = build_seed_tag_profile(client, seeds).await;
    Ok(post_process(scored, seeds.entries.len(), seed_tag_profile))
}

fn score_candidate(
    info: crate::models::TrackInfo,
    artist: String,
    track_name: String,
    seed_artist_count: usize,
    total_seed_artists: usize,
    artist_tags: Vec<String>,
) -> Option<TrackDiscoveryItem> {
    if info.user_plays() > 0 {
        return None;
    }
    if info.listeners > MAX_LISTENER_CEILING {
        return None;
    }

    let conviction = if total_seed_artists > 0 {
        seed_artist_count as f64 / total_seed_artists as f64
    } else {
        0.0
    };
    let stickiness = info.stickiness();
    let composite = conviction * stickiness * 10_000.0;
    let conv_score = (conviction * 100.0) as usize;

    // Prefer track-level tags; fall back to the artist's tags.
    let top_tags: Vec<String> = {
        let track_tags: Vec<String> = info
            .toptags
            .map(|mut t| { t.tag.truncate(6); t.tag.into_iter().map(|tag| tag.name).collect() })
            .unwrap_or_default();
        if !track_tags.is_empty() { track_tags } else { artist_tags }
    };

    Some(TrackDiscoveryItem {
        name: track_name,
        artist,
        conviction_score: conv_score,
        stickiness_score: stickiness,
        composite_score: composite,
        total_listeners: info.listeners,
        top_tags,
        source_seeds: vec![],
        taste_alignment: 0.0,
    })
}

fn post_process(mut tracks: Vec<TrackDiscoveryItem>, seed_count: usize, seed_tag_profile: HashMap<String, f64>) -> TrackDiscoveryResponse {
    let top_genres = aggregate_genres(&tracks);

    for t in &mut tracks {
        let alignment: f64 = t
            .top_tags
            .iter()
            .map(|tag| seed_tag_profile.get(&tag.to_lowercase()).copied().unwrap_or(0.0))
            .sum();
        t.taste_alignment = alignment.min(1.0);
    }

    let genre_weight_map: HashMap<String, f64> = top_genres
        .iter()
        .map(|g| (g.name.to_lowercase(), g.weight / 100.0))
        .collect();
    let mut diverse = enforce_diversity(tracks, &genre_weight_map);
    diverse.truncate(MAX_RESULTS);
    let depth_score = compute_depth_score(&diverse);

    println!("TRACK_DONE: {} tracks after diversity pass", diverse.len());

    let message = if seed_count < 10 {
        Some("Limited track history — try a longer time period for better results.".to_string())
    } else {
        None
    };

    TrackDiscoveryResponse {
        tracks: diverse,
        top_genres,
        active_seed_count: seed_count,
        depth_score,
        message,
    }
}

fn aggregate_genres(tracks: &[TrackDiscoveryItem]) -> Vec<GenreWeight> {
    let mut tag_weights: HashMap<String, usize> = HashMap::new();
    let mut total = 0usize;
    for t in tracks {
        for tag in t.top_tags.iter().take(3) {
            *tag_weights.entry(tag.clone()).or_insert(0) += t.conviction_score.max(1);
            total += t.conviction_score.max(1);
        }
    }
    let mut genres: Vec<GenreWeight> = tag_weights
        .into_iter()
        .map(|(name, w)| GenreWeight {
            name,
            weight: if total > 0 {
                (w as f64 / total as f64) * 100.0
            } else {
                0.0
            },
        })
        .collect();
    genres.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    genres.truncate(5);
    genres
}

fn enforce_diversity(
    tracks: Vec<TrackDiscoveryItem>,
    genre_weight_map: &HashMap<String, f64>,
) -> Vec<TrackDiscoveryItem> {
    let mut slot_count: HashMap<String, usize> = HashMap::new();
    tracks
        .into_iter()
        .filter(|t| {
            let primary = t
                .top_tags
                .iter()
                .max_by(|a, b| {
                    let wa = genre_weight_map.get(&a.to_lowercase()).copied().unwrap_or(0.0);
                    let wb = genre_weight_map.get(&b.to_lowercase()).copied().unwrap_or(0.0);
                    wa.partial_cmp(&wb).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|t| t.to_lowercase())
                .unwrap_or_else(|| t.artist.to_lowercase());
            let count = slot_count.entry(primary).or_insert(0);
            if *count < DIVERSITY_SLOTS_PER_GENRE {
                *count += 1;
                true
            } else {
                false
            }
        })
        .collect()
}

fn compute_depth_score(tracks: &[TrackDiscoveryItem]) -> f64 {
    if tracks.is_empty() {
        return 0.0;
    }
    let ceiling = (MAX_LISTENER_CEILING as f64 + 1.0).log10();
    let total_weight: f64 = tracks.iter().map(|t| t.composite_score).sum();
    if total_weight <= 0.0 {
        return 0.0;
    }
    let weighted_sum: f64 = tracks
        .iter()
        .map(|t| {
            let obscurity = ceiling - (t.total_listeners as f64 + 1.0).log10();
            obscurity.max(0.0) * t.composite_score
        })
        .sum();
    ((weighted_sum / total_weight) / ceiling * 100.0).min(100.0)
}
