/// Phase 3+4: score candidates, enforce diversity, compute the depth score.
///
/// For each candidate:
/// 1. Fetch artist info (listener count, tags, user play count)
/// 2. Filter out artists the user already listens to
/// 3. Filter out artists above the listener ceiling (too mainstream)
/// 4. Score: conviction (weighted recommender count) × stickiness (monthly/total listeners)
/// 5. Cross-validation bonus if the artist also appeared in the tag graph
///
/// Post-processing:
/// - Aggregate genre weights from the result set
/// - Compute taste_alignment per artist (tag overlap with user genre profile)
/// - Diversity enforcement: cap at 3 artists per primary genre to prevent
///   one genre from monopolising the results
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
const MAX_LISTENER_CEILING: u64 = 25_000;
/// Cap each seed's contribution to conviction so one dominant artist
/// doesn't flood the ranking at the expense of multi-seed agreement
const CONVICTION_CAP: f64 = 3.0;
const CROSS_VALIDATION_BONUS: f64 = 0.5;
const DIVERSITY_SLOTS_PER_GENRE: usize = 3;
/// Cap candidates sent to the info-fetch pass. 1500+ candidates × 12 concurrent
/// easily exceeds 90s. Top-by-recommender-count is a safe pre-filter — low-
/// recommender candidates have near-zero conviction scores anyway.
const MAX_CANDIDATES_FOR_INFO_FETCH: usize = 600;

pub async fn score_and_rank(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: CandidateMap,
    seeds: &Seeds,
    tag_candidates: &HashSet<String>,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let seed_tag_profile = build_seed_tag_profile(client, seeds).await;
    let scored = fetch_and_score(client, username, candidate_map, seeds, tag_candidates).await;
    Ok(post_process(scored, seeds.weights.len(), seed_tag_profile))
}

/// Fetch tags for the top N seed artists in parallel and build a weighted tag
/// frequency map reflecting the user's actual genre taste.
/// Each seed contributes proportionally to its blended weight; tags shared by
/// many high-weight seeds score highest.
async fn build_seed_tag_profile(
    client: &Arc<LastfmClient>,
    seeds: &Seeds,
) -> HashMap<String, f64> {
    const TOP_SEEDS: usize = 25;
    let mut sorted: Vec<_> = seeds.weights.iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<(String, f64)> = sorted.into_iter()
        .take(TOP_SEEDS)
        .map(|(n, w)| (n.clone(), *w))
        .collect();
    let total: f64 = top.iter().map(|(_, w)| w).sum::<f64>().max(1.0);

    let sem = Arc::new(Semaphore::new(8));
    let mut futs: FuturesUnordered<_> = top.into_iter().map(|(name, weight)| {
        let client = Arc::clone(client);
        let sem = Arc::clone(&sem);
        tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let tags = client.fetch_artist_tags(&name).await;
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
    println!("SEED_TAGS: profile with {} unique tags", profile.len());
    profile
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

    // Collect all raw results first so we can build a listener map for collab checks.
    let mut raw: Vec<(Artist, Vec<String>)> = Vec::new();
    while let Some(task_result) = info_futures.next().await {
        if let Ok((Ok(info_response), recommenders)) = task_result {
            raw.push((info_response.artist, recommenders));
        }
    }

    // Map of normalised name → listener count, used to verify collab components.
    // e.g. "Kendrick Lamar & SZA" → check "kendrick lamar" and "sza" individually.
    let listener_map: HashMap<String, u64> = raw.iter()
        .map(|(a, _)| (normalize_artist_name(&a.name), a.stats.listeners))
        .collect();

    let mut scored_artists: Vec<DiscoveryResponseItem> = raw
        .into_iter()
        .filter_map(|(artist, recommenders)| {
            score_candidate(artist, recommenders, seeds, tag_candidates, &listener_map)
        })
        .collect();

    scored_artists.sort_by(|a, b| {
        b.composite_score.partial_cmp(&a.composite_score).unwrap_or(std::cmp::Ordering::Equal)
    });

    scored_artists
}

fn collab_components(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    for sep in &[" & ", " feat. ", " ft. ", " x "] {
        if lower.contains(sep) {
            return name.split(sep).map(|s| s.trim().to_string()).collect();
        }
    }
    vec![]
}

fn score_candidate(
    mut artist: Artist,
    recommenders: Vec<String>,
    seeds: &Seeds,
    tag_candidates: &HashSet<String>,
    listener_map: &HashMap<String, u64>,
) -> Option<DiscoveryResponseItem> {
    // Skip artists the user already listens to
    let user_plays = artist.stats.userplaycount.as_ref()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    if user_plays > 0 {
        return None;
    }

    // Skip artists above the listener ceiling (too mainstream to surface)
    if artist.stats.listeners > MAX_LISTENER_CEILING {
        return None;
    }

    // For collaboration names (e.g. "Kendrick Lamar & SZA"), reject if any
    // component artist is individually above the ceiling. The joint entity can
    // have far fewer listeners than either artist alone, bypassing the filter.
    let components = collab_components(&artist.name);
    if !components.is_empty() {
        for component in &components {
            let norm = normalize_artist_name(component);
            if listener_map.get(&norm).map_or(false, |&l| l > MAX_LISTENER_CEILING) {
                return None;
            }
        }
    }

    // Deduplicate recommenders; compute conviction as weighted sum of seed weights
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

    // Bonus if the artist was independently confirmed by the tag graph
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

fn post_process(mut artists: Vec<DiscoveryResponseItem>, seed_count: usize, seed_tag_profile: HashMap<String, f64>) -> DiscoveryResponse {
    let top_genres = aggregate_genres(&artists);

    // taste_alignment: how well this candidate's tags match the user's actual seed artists.
    // Uses the seed tag profile (built from what the user listens to), not the output distribution.
    for artist in &mut artists {
        let alignment: f64 = artist.top_tags.iter()
            .map(|t| seed_tag_profile.get(&t.to_lowercase()).copied().unwrap_or(0.0))
            .sum();
        artist.taste_alignment = alignment.min(1.0);
    }

    // Diversity uses the output genre distribution so results spread across genres.
    let genre_weight_map: HashMap<String, f64> = top_genres.iter()
        .map(|g| (g.name.to_lowercase(), g.weight / 100.0))
        .collect();
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

/// Keep at most DIVERSITY_SLOTS_PER_GENRE artists per primary genre.
/// "Primary genre" = the tag with the highest weight in the user's profile.
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

/// Depth score (0–100): conviction-weighted average obscurity across the result set.
/// Uses sqrt(1 - listeners/ceiling) so the scale is perceptually linear:
///   0 listeners → 100, 5K → 89, 10K → 78, 20K → 45, 25K → 0.
fn compute_depth_score(artists: &[DiscoveryResponseItem]) -> f64 {
    if artists.is_empty() {
        return 0.0;
    }
    let ceiling = MAX_LISTENER_CEILING as f64;
    let total_weight: f64 = artists.iter().map(|a| a.composite_score).sum();
    if total_weight <= 0.0 {
        return 0.0;
    }
    let weighted_sum: f64 = artists.iter().map(|a| {
        let fraction = (a.total_listeners as f64 / ceiling).min(1.0);
        let obscurity = (1.0 - fraction).sqrt();
        obscurity * a.composite_score
    }).sum();
    ((weighted_sum / total_weight) * 100.0).min(100.0)
}
