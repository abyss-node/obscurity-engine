use crate::lastfm::LastfmClient;
use crate::models::{DiscoveryResponseItem, DiscoveryResponse, GenreWeight};
use futures::stream::{FuturesUnordered, StreamExt};
use std::collections::{HashSet, HashMap};
use std::sync::Arc;

pub async fn discover_obscure_artists(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let _period = period_str; // explicitly ignore the period param since we want absolute recent tracks

    // 0. Setup Dynamic Threshold (total scrobbles / total artists)
    let mut total_unique_artists: f64 = 0.0;
    match client.fetch_user_top_artists(&username, 1, crate::lastfm::TimePeriod::Overall).await {
        Ok(top) => {
            if let Some(attr) = top.topartists.attr {
                if let Ok(t) = attr.total.parse::<f64>() {
                    total_unique_artists = t;
                    println!("DEBUG: Found {} total unique artists in library", total_unique_artists);
                }
            }
        },
        Err(e) => eprintln!("WARNING: Could not fetch total artists from Last.fm: {}. Using fallback threshold logic.", e),
    }

    // 1. The Reverse Scrobble Search (Temporal Momentum)
    let mut page = 1;
    let mut artist_plays: HashMap<String, u64> = HashMap::new();
    let mut active_seeds_set: HashSet<String> = HashSet::new();
    let mut active_seeds: Vec<String> = Vec::new();
    let mut deepest_date: Option<String> = None;
    let mut dynamic_threshold: u64 = 15; // Starting fallback
    let mut threshold_calculated = false;

    loop {
        // Sleep 250ms natively to strictly obey 5 Req/Sec threshold on continuous pagination (429 bypass)
        tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
        
        let recent_res = match client.fetch_recent_tracks(&username, 200, page).await {
            Ok(res) => res,
            Err(e) => {
                eprintln!("Error fetching recent tracks page {}: {}", page, e);
                break;
            }
        };

        if page == 1 && !threshold_calculated {
            if let Some(ref total_str) = recent_res.recenttracks.attr.total {
                if let Ok(total_scrobbles) = total_str.parse::<f64>() {
                    if total_unique_artists > 0.0 {
                        let avg = total_scrobbles / total_unique_artists;
                        // Use a more forgiving 1.1x multiplier for better coverage
                        dynamic_threshold = (avg * 1.1).ceil() as u64;
                        if dynamic_threshold < 5 { dynamic_threshold = 5; }
                        println!("SUCCESS: Calculated Initial Dynamic Seed Threshold: {} ({} total scrobbles / {} unique artists)", dynamic_threshold, total_scrobbles, total_unique_artists);
                        threshold_calculated = true;
                    } else {
                        eprintln!("WARNING: Using fallback threshold of 10 due to missing denominator.");
                        dynamic_threshold = 10;
                        threshold_calculated = true;
                    }
                }
            }
        }

        // DYNAMIC WIDENING: If we are deep into history and haven't found seeds, aggressively lower the bar!
        if page % 15 == 0 && active_seeds.len() < 20 && dynamic_threshold > 5 {
            dynamic_threshold = (dynamic_threshold as f64 * 0.7).ceil() as u64;
            if dynamic_threshold < 5 { dynamic_threshold = 5; }
            println!("RELAXING_CONSTRAINTS: Dropping threshold to {} to find more seeds...", dynamic_threshold);
        }

        let tracks = recent_res.recenttracks.track;
        if tracks.is_empty() { break; }

        for track in tracks {
            // Continually update the deepest date encountered
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

            if active_seeds.len() >= 100 { break; }
        }

        if active_seeds.len() >= 100 { break; }

        if let Ok(total_pages) = recent_res.recenttracks.attr.total_pages.parse::<u32>() {
            if page >= total_pages { break; }
        }

        page += 1;
    }

    // Dynamic Normalization: Plays divided by the Threshold Base
    let mut seed_list: Vec<(String, u64)> = active_seeds
        .into_iter()
        .map(|name| {
            let plays = *artist_plays.get(&name).unwrap_or(&dynamic_threshold);
            (name, plays)
        })
        .collect();

    let mut seed_weights: HashMap<String, f64> = HashMap::new();

    for (name, plays) in seed_list {
        // Base normalization (e.g., 20 plays / 15 threshold = 1.33x Weight)
        // This completely shatters percentiles, allowing intense obsessions to scale infinitely!
        let base_multiplier = (plays as f64) / (dynamic_threshold as f64);
        seed_weights.insert(name, base_multiplier);
    }
    
    // Generate active seeds array explicitly for traversing next batch loops
    let final_seeds: Vec<String> = seed_weights.keys().cloned().collect();

    // 2. Fetch similar artists for all active filtered seeds concurrently with a staggered rate-limit
    let mut similar_fetch_futures = FuturesUnordered::new();
    
    for (i, name) in final_seeds.into_iter().enumerate() {
        let c = Arc::clone(&client);

        similar_fetch_futures.push(tokio::spawn(async move {
            // Stagger 100ms per task to obey Last.fm API rate constraints natively
            tokio::time::sleep(tokio::time::Duration::from_millis(100 * i as u64)).await;
            let res = c.fetch_similar_artists(&name, 20).await;
            (name, res) // Return the seed explicitly
        }));
    }

    // Map: Candidate Name -> Vec of Seed Recommenders
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

    // 3. For every unique similar artist result, fetch artist.getInfo concurrently
    let mut info_fetch_futures = FuturesUnordered::new();
    
    for (name, recommenders) in candidate_map {
        let c = Arc::clone(&client);
        let u = username.clone();

        info_fetch_futures.push(tokio::spawn(async move {
            let res = c.fetch_artist_info(&name, &u).await;
            (res, recommenders)
        }));
    }

    let mut obscure_artists = Vec::new();

    // 4. Collect results, apply the strict constraint, and measure Conviction mapping
    while let Some(res) = info_fetch_futures.next().await {
        if let Ok((Ok(info_res), recommenders)) = res {
            let mut artist = info_res.artist;
            
            // Deduplicate seed names
            let mut unique_recommenders = recommenders;
            unique_recommenders.sort();
            unique_recommenders.dedup();
            
            // Weighted Conviction Model (Percentile Mapping): Sum of Seed Percentiles
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
            
            // Map floating Percentile multiplier structurally directly (e.g. 1.49 -> 149 score)
            let conv_score = (weighted_conviction * 100.0) as usize;
            artist.conviction_score = Some(conv_score);
            artist.recommended_by = unique_recommenders.clone();
            
            // Check if user has already discovered/listened to them
            let user_plays = artist.stats.userplaycount.as_ref()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
                
            // Discard instantly if user has already played this artist
            if user_plays > 0 {
                continue;
            }
            
            // Strict constraint: discard if global listeners > 25,000
            if artist.stats.listeners <= 25_000 {
                artist.calculate_stickiness(); 
                
                let mut top_tags = Vec::new();
                if let Some(mut tags_obj) = artist.tags {
                    // Grab up to 5 structured tags
                    for t in tags_obj.tag.drain(..).take(5) {
                        top_tags.push(t.name);
                    }
                }

                let stickiness = artist.stickiness_score.unwrap_or(0.0);
                let composite_score = (conv_score as f64) * stickiness;

                // Sort the seeds internally by highest percentile recommendation weight
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

    // 5. Sort the remaining list by Composite Score (desc)
    obscure_artists.sort_by(|a, b| {
        b.composite_score.partial_cmp(&a.composite_score).unwrap_or(std::cmp::Ordering::Equal)
    });

    // 6. Tag Aggregation & Weighting (Top 5 tags across the universe)
    let mut tag_weights: HashMap<String, usize> = HashMap::new();
    let mut total_weight = 0;

    for artist in &obscure_artists {
        let weight = artist.conviction_score;
        // Collect top 3 tags for the dictionary weighting
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

    // Sort heavily weighted tags to the top!
    top_genres.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    top_genres.truncate(5);

    Ok(DiscoveryResponse {
        artists: obscure_artists,
        top_genres,
        deepest_date,
        active_seed_count: seed_weights.len(),
    })
}
