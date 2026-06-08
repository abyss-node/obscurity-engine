/// Phase 3+4: score candidates, enforce diversity, compute the depth score.
///
/// For each candidate:
/// 1. Fetch all artist info (filter only user's already-heard artists)
/// 2. Compute genre-relative listener ceilings from the full candidate pool
/// 3. Filter out artists above their genre ceiling (too mainstream for their scene)
/// 4. Score: conviction (weighted recommender count) × stickiness (monthly/total listeners)
/// 5. Cross-validation bonus if the artist also appeared in the tag graph
///
/// Post-processing:
/// - Aggregate genre weights from the result set
/// - Compute taste_alignment per artist (tag overlap with user genre profile)
/// - Diversity enforcement: cap at 3 artists per primary genre
/// - Depth score: listener-weighted obscurity metric (0–100)
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::LastfmClient;
use crate::models::{Artist, DiscoveryResponse, DiscoveryResponseItem, GenreWeight, SourceSeed};
use crate::utils::normalize_artist_name;
use super::seeds::Seeds;
use super::candidates::CandidateMap;

const INFO_CONCURRENCY: usize = 12;
/// Cap candidates sent to the info-fetch pass. 1500+ candidates × 12 concurrent
/// easily exceeds 90s. Top-by-recommender-count is a safe pre-filter — low-
/// recommender candidates have near-zero conviction scores anyway.
const MAX_CANDIDATES_FOR_INFO_FETCH: usize = 400;
/// Accept artists up to this multiple above their genre's median listener count.
const GENRE_CEILING_MULTIPLIER: f64 = 2.0;
/// Hard cap regardless of genre — no truly mainstream artists.
const ABSOLUTE_LISTENER_CAP: u64 = 75_000;
/// Min samples needed to trust a genre's median; smaller buckets fall back to global median.
const MIN_GENRE_SAMPLES: usize = 3;
/// Fallback ceiling when a genre bucket is too small.
const FALLBACK_CEILING: u64 = 25_000;
const CONVICTION_CAP: f64 = 3.0;
const CROSS_VALIDATION_BONUS: f64 = 0.5;
const DIVERSITY_SLOTS_PER_GENRE: usize = 3;

pub async fn score_and_rank(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: CandidateMap,
    seeds: &Seeds,
    tag_candidates: &HashSet<String>,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let scored = fetch_and_score(client, username, candidate_map, seeds, tag_candidates).await;
    Ok(post_process(scored, seeds.weights.len()))
}

/// Fetch raw artist info for all candidates, filtering only artists the user already plays.
async fn fetch_all_raw(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: CandidateMap,
) -> Vec<(Artist, Vec<String>)> {
    let semaphore = Arc::new(Semaphore::new(INFO_CONCURRENCY));
    let mut info_futures = FuturesUnordered::new();

    for (_norm_key, (name, recommenders)) in candidate_map {
        let client = Arc::clone(client);
        let username = username.to_string();
        let semaphore = Arc::clone(&semaphore);
        info_futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            let result = client.fetch_artist_info(&name, &username).await;
            (result, recommenders)
        }));
    }

    let mut raw = Vec::new();
    while let Some(task_result) = info_futures.next().await {
        if let Ok((Ok(info_response), recommenders)) = task_result {
            let artist = info_response.artist;
            let user_plays = artist.stats.userplaycount.as_ref()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            if user_plays > 0 {
                continue;
            }
            raw.push((artist, recommenders));
        }
    }
    raw
}

fn primary_tag(artist: &Artist) -> String {
    artist.tags.as_ref()
        .and_then(|tags| tags.tag.first())
        .map(|t| t.name.to_lowercase())
        .unwrap_or_else(|| "untagged".to_string())
}

fn median_u64(values: &mut Vec<u64>) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2
    } else {
        values[mid]
    })
}

/// Compute per-genre listener ceilings from the raw candidate pool.
/// Genre = primary tag (top_tags[0]). Falls back to global median for small buckets.
fn compute_genre_ceilings(raw: &[(Artist, Vec<String>)]) -> HashMap<String, u64> {
    let mut genre_listeners: HashMap<String, Vec<u64>> = HashMap::new();
    let mut all_listeners: Vec<u64> = Vec::new();

    for (artist, _) in raw {
        let listeners = artist.stats.listeners;
        all_listeners.push(listeners);
        genre_listeners.entry(primary_tag(artist)).or_default().push(listeners);
    }

    let global_median = median_u64(&mut all_listeners).unwrap_or(FALLBACK_CEILING);
    println!("GENRE_CEILINGS: global median listeners = {}", global_median);

    let mut ceilings = HashMap::new();
    for (genre, mut counts) in genre_listeners {
        let median = if counts.len() >= MIN_GENRE_SAMPLES {
            median_u64(&mut counts).unwrap_or(global_median)
        } else {
            global_median
        };
        let ceiling = ((median as f64) * GENRE_CEILING_MULTIPLIER) as u64;
        ceilings.insert(genre, ceiling.min(ABSOLUTE_LISTENER_CAP));
    }
    ceilings
}

async fn fetch_and_score(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: CandidateMap,
    seeds: &Seeds,
    tag_candidates: &HashSet<String>,
) -> Vec<DiscoveryResponseItem> {
    // Pre-filter: keep only the top candidates by recommender count before the
    // expensive info-fetch pass. Cuts pipeline time from 90s+ to ~40s for large pools.
    let candidate_map = if candidate_map.len() > MAX_CANDIDATES_FOR_INFO_FETCH {
        let mut ranked: Vec<_> = candidate_map.into_iter().collect();
        ranked.sort_by(|a, b| b.1.1.len().cmp(&a.1.1.len()));
        ranked.truncate(MAX_CANDIDATES_FOR_INFO_FETCH);
        println!("SCORING: capped to {} candidates (was more)", MAX_CANDIDATES_FOR_INFO_FETCH);
        ranked.into_iter().collect()
    } else {
        candidate_map
    };
    let raw = fetch_all_raw(client, username, candidate_map).await;
    let genre_ceilings = compute_genre_ceilings(&raw);

    let mut scored: Vec<DiscoveryResponseItem> = raw
        .into_iter()
        .filter_map(|(artist, recommenders)| {
            score_candidate(artist, recommenders, seeds, tag_candidates, &genre_ceilings)
        })
        .collect();

    scored.sort_by(|a, b| {
        b.composite_score.partial_cmp(&a.composite_score).unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}

fn score_candidate(
    mut artist: Artist,
    recommenders: Vec<String>,
    seeds: &Seeds,
    tag_candidates: &HashSet<String>,
    genre_ceilings: &HashMap<String, u64>,
) -> Option<DiscoveryResponseItem> {
    // Genre-relative ceiling: reject artists more than 2× above their genre's median
    let genre = primary_tag(&artist);
    let ceiling = genre_ceilings.get(&genre).copied().unwrap_or(FALLBACK_CEILING);
    if artist.stats.listeners > ceiling {
        return None;
    }

    let mut unique_recommenders = recommenders;
    unique_recommenders.sort();
    unique_recommenders.dedup();

    let mut weighted_conviction: f64 = 0.0;
    let mut source_seeds: Vec<SourceSeed> = Vec::new();
    for recommender in &unique_recommenders {
        if let Some(&weight) = seeds.weights.get(recommender) {
            let capped = weight.min(CONVICTION_CAP);
            weighted_conviction += capped;
            source_seeds.push(SourceSeed { name: recommender.clone(), percentile: capped });
        }
    }

    let cross_validated = tag_candidates.contains(&normalize_artist_name(&artist.name));
    if cross_validated {
        weighted_conviction += CROSS_VALIDATION_BONUS;
    }

    let conv_score = (weighted_conviction * 100.0) as usize;
    artist.calculate_stickiness();
    let stickiness = artist.stickiness_score.unwrap_or(0.0);
    let composite_score = (conv_score as f64) * stickiness;

    let top_tags: Vec<String> = artist.tags
        .map(|mut tags| tags.tag.drain(..).take(5).map(|t| t.name).collect())
        .unwrap_or_default();

    source_seeds.sort_by(|a, b| b.percentile.partial_cmp(&a.percentile).unwrap_or(std::cmp::Ordering::Equal));

    Some(DiscoveryResponseItem {
        name: artist.name,
        stickiness_score: stickiness,
        conviction_score: conv_score,
        composite_score,
        total_listeners: artist.stats.listeners,
        top_tags,
        source_seeds,
        cross_validated,
        taste_alignment: 0.0,
        velocity: None,
    })
}

fn post_process(mut artists: Vec<DiscoveryResponseItem>, seed_count: usize) -> DiscoveryResponse {
    let top_genres = aggregate_genres(&artists);

    let genre_weight_map: HashMap<String, f64> = top_genres.iter()
        .map(|g| (g.name.to_lowercase(), g.weight / 100.0))
        .collect();
    for artist in &mut artists {
        let alignment: f64 = artist.top_tags.iter()
            .map(|t| genre_weight_map.get(&t.to_lowercase()).copied().unwrap_or(0.0))
            .sum();
        artist.taste_alignment = (alignment / 5.0).min(1.0);
    }

    let diverse_artists = enforce_diversity(artists, &genre_weight_map);
    let depth_score = compute_depth_score(&diverse_artists);

    println!("DONE: {} artists after diversity pass ({} seeds)", diverse_artists.len(), seed_count);

    let low_data_message = if seed_count < 20 {
        Some("Your scrobble history is limited — results may include artists you already know. Deeper listening history improves accuracy.".to_string())
    } else {
        None
    };

    DiscoveryResponse {
        artists: diverse_artists,
        top_genres,
        deepest_date: None,
        active_seed_count: seed_count,
        depth_score,
        message: low_data_message,
    }
}

fn aggregate_genres(artists: &[DiscoveryResponseItem]) -> Vec<GenreWeight> {
    let mut tag_weights: HashMap<String, usize> = HashMap::new();
    let mut total_weight = 0usize;
    for artist in artists {
        for tag in artist.top_tags.iter().take(3) {
            *tag_weights.entry(tag.clone()).or_insert(0) += artist.conviction_score;
            total_weight += artist.conviction_score;
        }
    }

    let mut genres: Vec<GenreWeight> = tag_weights.into_iter()
        .map(|(name, weight)| GenreWeight {
            name,
            weight: if total_weight > 0 {
                (weight as f64 / total_weight as f64) * 100.0
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
    artists: Vec<DiscoveryResponseItem>,
    genre_weight_map: &HashMap<String, f64>,
) -> Vec<DiscoveryResponseItem> {
    let mut slot_count: HashMap<String, usize> = HashMap::new();
    artists.into_iter().filter(|artist| {
        let primary_genre = artist.top_tags.iter()
            .max_by(|a, b| {
                let wa = genre_weight_map.get(&a.to_lowercase()).copied().unwrap_or(0.0);
                let wb = genre_weight_map.get(&b.to_lowercase()).copied().unwrap_or(0.0);
                wa.partial_cmp(&wb).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|t| t.to_lowercase())
            .unwrap_or_else(|| "untagged".to_string());
        let count = slot_count.entry(primary_genre).or_insert(0);
        if *count < DIVERSITY_SLOTS_PER_GENRE { *count += 1; true } else { false }
    }).collect()
}

/// Depth score (0–100): listener-weighted average obscurity across the result set.
/// Uses ABSOLUTE_LISTENER_CAP as the ceiling reference so scores spread across the full range.
fn compute_depth_score(artists: &[DiscoveryResponseItem]) -> f64 {
    if artists.is_empty() {
        return 0.0;
    }
    let ceiling = (ABSOLUTE_LISTENER_CAP as f64 + 1.0).log10();
    let total_weight: f64 = artists.iter().map(|a| a.composite_score).sum();
    if total_weight <= 0.0 {
        return 0.0;
    }
    let weighted_sum: f64 = artists.iter().map(|a| {
        let obscurity = ceiling - (a.total_listeners as f64 + 1.0).log10();
        obscurity.max(0.0) * a.composite_score
    }).sum();
    ((weighted_sum / total_weight) / ceiling * 100.0).min(100.0)
}
