use crate::lastfm::LastfmClient;
use crate::models::{DiscoveryResponseItem, DiscoveryResponse, GenreWeight};
use futures::stream::{FuturesUnordered, StreamExt};
use std::collections::{HashSet, HashMap};
use std::sync::Arc;
use tokio::sync::Semaphore;

const MAX_SEEDS: usize = 100;
// Concurrency limits - critical for Render free tier + Last.fm rate limits
const SIMILAR_CONCURRENCY: usize = 5;   // max concurrent "get similar" calls
const INFO_CONCURRENCY: usize = 8;      // max concurrent "get info" calls

pub async fn discover_obscure_artists(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let _period = period_str;

    // ── 0. Dynamic threshold calc ─────────────────────────────────────────────
    let mut total_unique_artists: f64 = 0.0;
    match client.fetch_user_top_artists(&username, 1, crate::lastfm::TimePeriod::Overall).await {
        Ok(top) => {
            if let Some(attr) = top.topartists.attr {
                if let Ok(t) = attr.total.parse::<f64>() {
                    total_unique_artists = t;
                    println!("DEBUG: {} total unique artists in library", total_unique_artists);
                }
            }
        },
        Err(e) => eprintln!("WARNING: Could not fetch total artists: {}. Using fallback.", e),
    }

    // ── 1. Reverse Scrobble Search (sequential, but minimal delay) ────────────
    let mut page = 1u32;
    let mut artist_plays: HashMap<String, u64> = HashMap::new();
    let mut active_seeds_set: HashSet<String> = HashSet::new();
    let mut active_seeds: Vec<String> = Vec::new();
    let mut deepest_date: Option<String> = None;
    let mut dynamic_threshold: u64 = 15;
    let mut threshold_calculated = false;
    let mut total_pages: u32 = 1;

    loop {
        // Minimal delay — just enough to stay within 5 req/s on Last.fm
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

        let recent_res = match client.fetch_recent_tracks(&username, 200, page).await {
            Ok(res) => res,
            Err(e) => {
                eprintln!("Error fetching recent tracks page {}: {}", page, e);
                break;
            }
        };

        // Grab total pages on first fetch
        if page == 1 {
            if let Ok(tp) = recent_res.recenttracks.attr.total_pages.parse::<u32>() {
                total_pages = tp;
                println!("DEBUG: {} total pages in scrobble history", total_pages);
            }
        }

        // Calculate dynamic threshold once
        if !threshold_calculated {
            if let Some(ref total_str) = recent_res.recenttracks.attr.total {
                if let Ok(total_scrobbles) = total_str.parse::<f64>() {
                    if total_unique_artists > 0.0 {
                        let avg = total_scrobbles / total_unique_artists;
                        dynamic_threshold = (avg * 1.1).ceil() as u64;
                        if dynamic_threshold < 5 { dynamic_threshold = 5; }
                        if dynamic_threshold > 50 { dynamic_threshold = 50; } // cap it - don't make seeds impossible
                        println!("SUCCESS: Dynamic seed threshold: {} ({} scrobbles / {} artists)", 
                            dynamic_threshold, total_scrobbles, total_unique_artists);
                    } else {
                        dynamic_threshold = 10;
                    }
                    threshold_calculated = true;
                }
            }
        }

        // Adaptive widening — lower threshold if we're struggling
        if page % 10 == 0 && active_seeds.len() < 20 && dynamic_threshold > 5 {
            dynamic_threshold = (dynamic_threshold as f64 * 0.75).ceil() as u64;
            if dynamic_threshold < 5 { dynamic_threshold = 5; }
            println!("RELAXING: Seed threshold dropped to {}", dynamic_threshold);
        }

        let tracks = recent_res.recenttracks.track;
        if tracks.is_empty() { break; }

        for track in tracks {
            if let Some(ref d) = track.date {
                deepest_date = Some(d.text.clone());
            }
            let artist_name = track.artist.name;
            let counter = artist_plays.entry(artist_name.clone()).or_insert(0);
            *counter += 1;

            if *counter >= dynamic_threshold && !active_seeds_set.contains(&artist_name) {
                active_seeds_set.insert(artist_name.clone());
                active_seeds.push(artist_name);
            }

            if active_seeds.len() >= MAX_SEEDS { break; }
        }

        if active_seeds.len() >= MAX_SEEDS { break; }
        if page >= total_pages { break; }
        page += 1;
    }

    println!("SEEDS COLLECTED: {} seeds across {} scrobble pages", active_seeds.len(), page);

    // Seed weights
    let mut seed_weights: HashMap<String, f64> = HashMap::new();
    for name in &active_seeds {
        let plays = *artist_plays.get(name).unwrap_or(&dynamic_threshold);
        let base_multiplier = (plays as f64) / (dynamic_threshold as f64);
        seed_weights.insert(name.clone(), base_multiplier);
    }

    // ── 2. Fetch similar artists with semaphore-controlled concurrency ─────────
    let similar_semaphore = Arc::new(Semaphore::new(SIMILAR_CONCURRENCY));
    let mut similar_fetch_futures = FuturesUnordered::new();

    for name in active_seeds.iter().cloned() {
        let c = Arc::clone(&client);
        let sem = Arc::clone(&similar_semaphore);

        similar_fetch_futures.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            // Small jitter to prevent thundering herd
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            let res = c.fetch_similar_artists(&name, 20).await;
            (name, res)
        }));
    }

    let mut candidate_map: HashMap<String, Vec<String>> = HashMap::new();

    while let Some(res) = similar_fetch_futures.next().await {
        if let Ok((seed_name, Ok(similar_res))) = res {
            for sim_artist in similar_res.similarartists.artist {
                candidate_map.entry(sim_artist.name)
                    .or_default()
                    .push(seed_name.clone());
            }
        }
    }

    println!("CANDIDATES: {} unique candidate artists found", candidate_map.len());

    // ── 3. Fetch artist info with semaphore-controlled concurrency ─────────────
    let info_semaphore = Arc::new(Semaphore::new(INFO_CONCURRENCY));
    let mut info_fetch_futures = FuturesUnordered::new();

    for (name, recommenders) in candidate_map {
        let c = Arc::clone(&client);
        let u = username.clone();
        let sem = Arc::clone(&info_semaphore);

        info_fetch_futures.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let res = c.fetch_artist_info(&name, &u).await;
            (res, recommenders)
        }));
    }

    let mut obscure_artists = Vec::new();

    while let Some(res) = info_fetch_futures.next().await {
        if let Ok((Ok(info_res), recommenders)) = res {
            let mut artist = info_res.artist;

            let mut unique_recommenders = recommenders;
            unique_recommenders.sort();
            unique_recommenders.dedup();

            let mut weighted_conviction: f64 = 0.0;
            let mut source_seeds = Vec::new();
            for r in &unique_recommenders {
                if let Some(&weight) = seed_weights.get(r) {
                    weighted_conviction += weight;
                    source_seeds.push(crate::models::SourceSeed {
                        name: r.clone(),
                        percentile: weight,
                    });
                }
            }

            let conv_score = (weighted_conviction * 100.0) as usize;
            artist.conviction_score = Some(conv_score);
            artist.recommended_by = unique_recommenders;

            let user_plays = artist.stats.userplaycount.as_ref()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);

            if user_plays > 0 { continue; }

            if artist.stats.listeners <= 25_000 {
                artist.calculate_stickiness();

                let mut top_tags = Vec::new();
                if let Some(mut tags_obj) = artist.tags {
                    for t in tags_obj.tag.drain(..).take(5) {
                        top_tags.push(t.name);
                    }
                }

                let stickiness = artist.stickiness_score.unwrap_or(0.0);
                let composite_score = (conv_score as f64) * stickiness;

                source_seeds.sort_by(|a, b| b.percentile.partial_cmp(&a.percentile).unwrap_or(std::cmp::Ordering::Equal));

                obscure_artists.push(DiscoveryResponseItem {
                    name: artist.name,
                    stickiness_score: stickiness,
                    conviction_score: conv_score,
                    composite_score,
                    total_listeners: artist.stats.listeners,
                    top_tags,
                    source_seeds,
                });
            }
        }
    }

    obscure_artists.sort_by(|a, b| {
        b.composite_score.partial_cmp(&a.composite_score).unwrap_or(std::cmp::Ordering::Equal)
    });

    // ── Tag Aggregation ────────────────────────────────────────────────────────
    let mut tag_weights: HashMap<String, usize> = HashMap::new();
    let mut total_weight = 0;

    for artist in &obscure_artists {
        let weight = artist.conviction_score;
        for tag in artist.top_tags.iter().take(3) {
            *tag_weights.entry(tag.clone()).or_insert(0) += weight;
            total_weight += weight;
        }
    }

    let mut top_genres: Vec<GenreWeight> = tag_weights
        .into_iter()
        .map(|(name, w)| GenreWeight {
            name,
            weight: if total_weight > 0 {
                (w as f64 / total_weight as f64) * 100.0
            } else {
                0.0
            },
        })
        .collect();

    top_genres.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    top_genres.truncate(5);

    println!("DONE: {} obscure artists discovered", obscure_artists.len());

    Ok(DiscoveryResponse {
        artists: obscure_artists,
        top_genres,
        deepest_date,
        active_seed_count: seed_weights.len(),
    })
}
