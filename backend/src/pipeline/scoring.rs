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
use crate::lastfm::{LastfmClient, is_transient_error};
use crate::models::{Artist, DiscoveryResponse, DiscoveryResponseItem, GenreWeight, SourceSeed};
use crate::utils::normalize_artist_name;
use super::seeds::Seeds;
use super::candidates::CandidateMap;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

const INFO_CONCURRENCY: usize = 12;
const MAX_LISTENER_CEILING: u64 = 25_000;
/// Cap each seed's contribution to conviction so one dominant artist
/// doesn't flood the ranking at the expense of multi-seed agreement
const CONVICTION_CAP: f64 = 3.0;
const CROSS_VALIDATION_BONUS: f64 = 0.5;
// Popularity-neutral cross-validation: a candidate also counts as dual-signal
// when this many of its own tags carry at least this much weight in the user's
// seed-genre profile. Lets obscure deep cuts earn the badge that the
// popularity-ranked tag graph alone never gives them. (Eval-tuned, 2026-06.)
const XVAL_OVERLAP_MIN_TAGS: usize = 3;
const XVAL_OVERLAP_MIN_WEIGHT: f64 = 0.15;
const DIVERSITY_SLOTS_PER_GENRE: usize = 3;
/// Final cap on recommendations returned per run. We'd rather hand the user a
/// short, high-conviction set they'll actually listen to than fire-hose them.
const MAX_RECOMMENDATIONS: usize = 25;  // default view shows 10; "view more" reveals the rest
const DEFAULT_SHOWN: usize = 10;        // the obscurity index describes this default top slice
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
    under_threshold: Option<u64>,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let seed_tag_profile = build_seed_tag_profile(client, seeds).await?;
    let scored = fetch_and_score(client, username, candidate_map, seeds, tag_candidates, &seed_tag_profile, under_threshold).await?;
    Ok(post_process(scored, seeds.weights.len(), seed_tag_profile))
}

/// Fetch tags for the top N seed artists in parallel and build a weighted tag
/// frequency map reflecting the user's actual genre taste.
/// Each seed contributes proportionally to its blended weight; tags shared by
/// many high-weight seeds score highest.
async fn build_seed_tag_profile(
    client: &Arc<LastfmClient>,
    seeds: &Seeds,
) -> Result<HashMap<String, f64>, BoxError> {
    const TOP_SEEDS: usize = 40;
    const TAGS_PER_SEED: usize = 5;
    let mut sorted: Vec<_> = seeds.weights.iter().collect();
    // Tiebreak by name so the top-N seed selection is stable across runs.
    sorted.sort_by(|a, b| {
        b.1.partial_cmp(a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(b.0))
    });
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
            let tags = client.fetch_artist_tags_checked(&name).await;
            (tags, weight)
        })
    }).collect();

    let mut profile: HashMap<String, f64> = HashMap::new();
    while let Some(task) = futs.next().await {
        match task {
            Ok((Ok(tags), weight)) => {
                let share = weight / total;
                for tag in tags.iter().take(TAGS_PER_SEED) {
                    *profile.entry(tag.to_lowercase()).or_insert(0.0) += share;
                }
            }
            // A dropped seed-tag fetch shifts taste-alignment (which re-ranks and
            // changes the depth-score weighting) — fail-closed on transient failures.
            Ok((Err(e), _weight)) => {
                if is_transient_error(e.as_ref()) {
                    return Err(format!("seed-tag fetch failed: {}", e).into());
                }
            }
            Err(e) => return Err(format!("seed-tag task failed: {}", e).into()),
        }
    }

    // Normalize so the highest-weight tag = 1.0.
    // Without this, every entry is tiny (each seed contributes 1/N of total),
    // making alignment scores cluster near 0 even for perfect genre matches.
    let max_w = profile.values().cloned().fold(0.0_f64, f64::max);
    if max_w > 0.0 {
        for v in profile.values_mut() {
            *v /= max_w;
        }
    }

    println!("SEED_TAGS: profile with {} unique tags (max_w={:.3})", profile.len(), max_w);
    Ok(profile)
}

async fn fetch_and_score(
    client: &Arc<LastfmClient>,
    username: &str,
    candidate_map: CandidateMap,
    seeds: &Seeds,
    tag_candidates: &HashSet<String>,
    seed_tag_profile: &HashMap<String, f64>,
    under_threshold: Option<u64>,
) -> Result<Vec<DiscoveryResponseItem>, BoxError> {
    // Normalized set of the user's own seed names — barred from recommendation
    // (matches the eval's `exclude_known = deep_known | seed_norms`). Built once
    // here rather than re-normalizing every seed inside the per-candidate loop.
    let seed_norms: HashSet<String> = seeds.names.iter()
        .map(|n| normalize_artist_name(n))
        .collect();
    // Pre-filter: keep only the top candidates by recommender count before the
    // expensive info-fetch pass. Cuts pipeline time from 90s+ to ~40s for large pools.
    let candidate_map = if candidate_map.len() > MAX_CANDIDATES_FOR_INFO_FETCH {
        let mut ranked: Vec<_> = candidate_map.into_iter().collect();
        // Tiebreak by normalized key so equal-recommender candidates at the cap
        // boundary are kept/dropped deterministically (this sets #candidates).
        ranked.sort_by(|a, b| b.1.1.len().cmp(&a.1.1.len()).then_with(|| a.0.cmp(&b.0)));
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
        match task_result {
            Ok((Ok(info_response), recommenders)) => raw.push((info_response.artist, recommenders)),
            // A dropped listener-count fetch removes a candidate before the 25K
            // ceiling and depth-score math — fail-closed on transient failures so
            // #candidates and the obscurity score are reproducible. A permanent
            // failure (artist Last.fm has no info for) is deterministic, so skip it.
            Ok((Err(e), _recommenders)) => {
                if is_transient_error(e.as_ref()) {
                    return Err(format!("artist-info fetch failed: {}", e).into());
                }
            }
            Err(e) => return Err(format!("artist-info task failed: {}", e).into()),
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
            score_candidate(artist, recommenders, seeds, tag_candidates, seed_tag_profile, &listener_map, under_threshold, &seed_norms)
        })
        .collect();

    scored_artists.sort_by(|a, b| {
        b.composite_score.partial_cmp(&a.composite_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(scored_artists)
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
    seed_tag_profile: &HashMap<String, f64>,
    listener_map: &HashMap<String, u64>,
    under_threshold: Option<u64>,
    seed_norms: &HashSet<String>,
) -> Option<DiscoveryResponseItem> {
    // Underexplored-novelty exclusion. With a threshold, only "deep" artists
    // (played >= threshold) are excluded — lightly-played and never-played artists
    // are recommendable. Without one (getinfo/count unavailable), fall back to the
    // strict rule: exclude any artist the user has ever played.
    let user_plays = artist.stats.userplaycount.as_ref()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    match under_threshold {
        Some(t) => { if user_plays >= t { return None; } }
        None    => { if user_plays > 0 { return None; } }
    }
    let reengagement = under_threshold.is_some() && user_plays > 0;

    // Never recommend one of the user's own seeds, regardless of play threshold
    // (matches the eval's explicit seed exclusion).
    if seed_norms.contains(&normalize_artist_name(&artist.name)) {
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

    // The candidate's own genre tags (taken now so they can feed cross-validation).
    let top_tags: Vec<String> = artist.tags
        .take()
        .map(|tags| tags.tag.into_iter().take(5).map(|t| t.name).collect())
        .unwrap_or_default();

    // Cross-validation = a second, independent genre signal beyond the
    // similar-artist graph. Earned two ways:
    //  1. the artist appears in the tag graph's top artists (popularity-ranked,
    //     so it mostly catches well-known names), OR
    //  2. its own tags overlap the user's seed-genre profile — popularity-NEUTRAL,
    //     so obscure deep cuts can qualify too (the de-biasing win).
    let in_tag_graph = tag_candidates.contains(&normalize_artist_name(&artist.name));
    let genre_overlap = top_tags.iter()
        .filter(|t| seed_tag_profile.get(&t.to_lowercase()).copied().unwrap_or(0.0) >= XVAL_OVERLAP_MIN_WEIGHT)
        .count();
    let cross_validated = in_tag_graph || genre_overlap >= XVAL_OVERLAP_MIN_TAGS;
    if cross_validated {
        weighted_conviction += CROSS_VALIDATION_BONUS;
    }

    let conv_score = (weighted_conviction * 100.0) as usize;
    artist.calculate_stickiness();
    let stickiness = artist.stickiness_score.unwrap_or(0.0);
    let composite_score = (conv_score as f64) * stickiness;

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
        user_playcount: user_plays,
        reengagement,
        spotify_url: None,
        bandcamp_url: None,
        this_is_url: None,
    })
}

fn post_process(mut artists: Vec<DiscoveryResponseItem>, seed_count: usize, seed_tag_profile: HashMap<String, f64>) -> DiscoveryResponse {
    let top_genres = aggregate_genres(&artists);

    // taste_alignment: how well this candidate's tags match the user's actual seed artists.
    // Normalized so the dominant genre = 1.0; summed across candidate's top tags.
    // Also applied as a 0–50% uplift on composite_score so genre fit influences ranking.
    for artist in &mut artists {
        let alignment: f64 = artist.top_tags.iter()
            .map(|t| seed_tag_profile.get(&t.to_lowercase()).copied().unwrap_or(0.0))
            .sum();
        artist.taste_alignment = alignment.min(1.0);
        artist.composite_score *= 1.0 + 0.5 * artist.taste_alignment;
    }
    // Re-sort after composite uplift from genre fit
    artists.sort_by(|a, b| {
        b.composite_score.partial_cmp(&a.composite_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });

    // Diversity uses the output genre distribution so results spread across genres.
    let genre_weight_map: HashMap<String, f64> = top_genres.iter()
        .map(|g| (g.name.to_lowercase(), g.weight / 100.0))
        .collect();
    let mut diverse_artists = enforce_diversity(artists, &genre_weight_map);
    // Keep only the strongest N. `diverse_artists` is already ranked best-first, so
    // this is the top N; the depth score below then reflects exactly what's shown.
    diverse_artists.truncate(MAX_RECOMMENDATIONS);
    // Obscurity index describes the default top slice (what's shown before
    // "view more"), so the headline number is stable whether or not the user expands.
    let depth_score = compute_depth_score(&diverse_artists[..diverse_artists.len().min(DEFAULT_SHOWN)]);

    println!("DONE: {} artists after diversity + cap ({} seeds)", diverse_artists.len(), seed_count);

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
    genres.sort_by(|a, b| {
        b.weight.partial_cmp(&a.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });
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
