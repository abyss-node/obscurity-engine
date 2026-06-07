/// Phase 3 (track mode): score, filter, and rank track candidates.
use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::LastfmClient;
use crate::models::{GenreWeight, TrackDiscoveryItem, TrackDiscoveryResponse, TrackSourceSeed};
use super::track_candidates::TrackCandidateMap;
use super::track_seeds::TrackSeeds;

const INFO_CONCURRENCY: usize = 10;
const MAX_LISTENER_CEILING: u64 = 100_000;
const CONVICTION_CAP: f64 = 3.0;
const DIVERSITY_SLOTS_PER_GENRE: usize = 3;

pub async fn score_and_rank(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: TrackCandidateMap,
    seeds: &TrackSeeds,
) -> Result<TrackDiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let semaphore = Arc::new(Semaphore::new(INFO_CONCURRENCY));
    let mut futures = FuturesUnordered::new();

    for (_key, (artist, track, recommenders)) in candidate_map {
        let client = Arc::clone(client);
        let username = username.to_string();
        let semaphore = Arc::clone(&semaphore);
        futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            let info = client.fetch_track_info(&artist, &track, &username).await;
            (artist, track, recommenders, info)
        }));
    }

    let mut scored: Vec<TrackDiscoveryItem> = Vec::new();
    while let Some(task_result) = futures.next().await {
        if let Ok((artist, track_name, recommenders, Ok(info_resp))) = task_result {
            if let Some(item) = score_candidate(info_resp.track, artist, track_name, recommenders, seeds) {
                scored.push(item);
            }
        }
    }

    scored.sort_by(|a, b| b.composite_score.partial_cmp(&a.composite_score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(post_process(scored, seeds.entries.len()))
}

fn score_candidate(
    info: crate::models::TrackInfo,
    artist: String,
    track_name: String,
    recommenders: Vec<String>,
    seeds: &TrackSeeds,
) -> Option<TrackDiscoveryItem> {
    if info.user_plays() > 0 {
        return None;
    }
    if info.listeners > MAX_LISTENER_CEILING {
        return None;
    }

    let mut unique_recommenders = recommenders;
    unique_recommenders.sort();
    unique_recommenders.dedup();

    let mut weighted_conviction: f64 = 0.0;
    let mut source_seeds: Vec<TrackSourceSeed> = Vec::new();
    for rec_key in &unique_recommenders {
        if let Some(&weight) = seeds.weights.get(rec_key) {
            let capped = weight.min(CONVICTION_CAP);
            weighted_conviction += capped;
            // Reconstruct display names from the key for the seed entry
            let parts: Vec<&str> = rec_key.splitn(2, "::").collect();
            let (seed_artist, seed_track) = if parts.len() == 2 {
                (parts[0].to_string(), parts[1].to_string())
            } else {
                (rec_key.clone(), String::new())
            };
            source_seeds.push(TrackSourceSeed {
                track: seed_track,
                artist: seed_artist,
                percentile: capped,
            });
        }
    }

    if weighted_conviction == 0.0 {
        return None;
    }

    let conv_score = (weighted_conviction * 100.0) as usize;
    let stickiness = info.stickiness();
    let composite_score = (conv_score as f64) * stickiness;

    let top_tags: Vec<String> = info.toptags
        .map(|mut t| { t.tag.truncate(5); t.tag.into_iter().map(|tag| tag.name).collect() })
        .unwrap_or_default();

    source_seeds.sort_by(|a, b| b.percentile.partial_cmp(&a.percentile).unwrap_or(std::cmp::Ordering::Equal));

    Some(TrackDiscoveryItem {
        name: track_name,
        artist,
        conviction_score: conv_score,
        stickiness_score: stickiness,
        composite_score,
        total_listeners: info.listeners,
        top_tags,
        source_seeds,
        taste_alignment: 0.0,
    })
}

fn post_process(mut tracks: Vec<TrackDiscoveryItem>, seed_count: usize) -> TrackDiscoveryResponse {
    let top_genres = aggregate_genres(&tracks);

    let genre_weight_map: HashMap<String, f64> = top_genres.iter()
        .map(|g| (g.name.to_lowercase(), g.weight / 100.0))
        .collect();

    for t in &mut tracks {
        let alignment: f64 = t.top_tags.iter()
            .map(|tag| genre_weight_map.get(&tag.to_lowercase()).copied().unwrap_or(0.0))
            .sum();
        t.taste_alignment = (alignment / 5.0).min(1.0);
    }

    let diverse = enforce_diversity(tracks, &genre_weight_map);
    let depth_score = compute_depth_score(&diverse);

    println!("TRACK_DONE: {} tracks after diversity pass", diverse.len());

    let message = if seed_count < 10 {
        Some("Your track history is limited — results may include tracks you already know.".to_string())
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
            *tag_weights.entry(tag.clone()).or_insert(0) += t.conviction_score;
            total += t.conviction_score;
        }
    }
    let mut genres: Vec<GenreWeight> = tag_weights.into_iter()
        .map(|(name, w)| GenreWeight {
            name,
            weight: if total > 0 { (w as f64 / total as f64) * 100.0 } else { 0.0 },
        })
        .collect();
    genres.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    genres.truncate(5);
    genres
}

fn enforce_diversity(tracks: Vec<TrackDiscoveryItem>, genre_weight_map: &HashMap<String, f64>) -> Vec<TrackDiscoveryItem> {
    let mut slot_count: HashMap<String, usize> = HashMap::new();
    tracks.into_iter().filter(|t| {
        let primary = t.top_tags.iter()
            .max_by(|a, b| {
                let wa = genre_weight_map.get(&a.to_lowercase()).copied().unwrap_or(0.0);
                let wb = genre_weight_map.get(&b.to_lowercase()).copied().unwrap_or(0.0);
                wa.partial_cmp(&wb).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|t| t.to_lowercase())
            .unwrap_or_else(|| "untagged".to_string());
        let count = slot_count.entry(primary).or_insert(0);
        if *count < DIVERSITY_SLOTS_PER_GENRE { *count += 1; true } else { false }
    }).collect()
}

fn compute_depth_score(tracks: &[TrackDiscoveryItem]) -> f64 {
    if tracks.is_empty() { return 0.0; }
    let ceiling = (MAX_LISTENER_CEILING as f64 + 1.0).log10();
    let total_weight: f64 = tracks.iter().map(|t| t.composite_score).sum();
    if total_weight <= 0.0 { return 0.0; }
    let weighted_sum: f64 = tracks.iter().map(|t| {
        let obscurity = ceiling - (t.total_listeners as f64 + 1.0).log10();
        obscurity.max(0.0) * t.composite_score
    }).sum();
    ((weighted_sum / total_weight) / ceiling * 100.0).min(100.0)
}
