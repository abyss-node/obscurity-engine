use crate::lastfm::{LastfmClient, TimePeriod};
use crate::models::{DiscoveryResponseItem, DiscoveryResponse, GenreWeight};
use futures::stream::{FuturesUnordered, StreamExt};
use std::collections::{HashSet, HashMap};
use std::sync::Arc;
use tokio::sync::Semaphore;

const MAX_SEEDS: usize = 100;
const SIMILAR_CONCURRENCY: usize = 5;
const INFO_CONCURRENCY: usize = 8;
// E1: Hard page cap prevents 300k-scrobble users from triggering 225s+ timeouts on Render free tier
const MAX_PAGES: u32 = 50;
// A3: Cap per-seed conviction to prevent one dominant artist flooding the ranking
const CONVICTION_CAP: f64 = 3.0;

fn parse_period(period_str: &str) -> TimePeriod {
    match period_str {
        "7day" => TimePeriod::SevenDay,
        "1month" => TimePeriod::OneMonth,
        "3month" => TimePeriod::ThreeMonth,
        "6month" => TimePeriod::SixMonth,
        "12month" => TimePeriod::TwelveMonth,
        _ => TimePeriod::Overall,
    }
}

/// Returns the unix timestamp for the start of the period, or None for 'overall'
fn period_from_timestamp(period: TimePeriod) -> Option<u64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    match period {
        TimePeriod::SevenDay   => Some(now.saturating_sub(7 * 86400)),
        TimePeriod::OneMonth   => Some(now.saturating_sub(30 * 86400)),
        TimePeriod::ThreeMonth => Some(now.saturating_sub(90 * 86400)),
        TimePeriod::SixMonth   => Some(now.saturating_sub(180 * 86400)),
        TimePeriod::TwelveMonth => Some(now.saturating_sub(365 * 86400)),
        TimePeriod::Overall    => None,
    }
}

pub async fn discover_obscure_artists(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let period = parse_period(&period_str);
    let from_ts = period_from_timestamp(period);

    // ── 0. Dynamic threshold calc ─────────────────────────────────────────────
    let mut total_unique_artists: f64 = 0.0;
    match client.fetch_user_top_artists(&username, 1, period).await {
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
    // A4: tracks the most recent scrobble unix timestamp per artist for time-weighting
    let mut artist_last_scrobble: HashMap<String, i64> = HashMap::new();
    let mut active_seeds_set: HashSet<String> = HashSet::new();
    let mut active_seeds: Vec<String> = Vec::new();
    let mut deepest_date: Option<String> = None;
    let mut dynamic_threshold: u64 = 15;
    let mut threshold_calculated = false;
    let mut total_pages: u32 = 1;

    loop {
        // Minimal delay — just enough to stay within 5 req/s on Last.fm
        tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

        let recent_res = match client.fetch_recent_tracks(&username, 200, page, from_ts).await {
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
            // A4: record the most recent scrobble timestamp for time-weighted seed scoring
            if let Some(ref d) = track.date {
                if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&d.text, "%d %b %Y, %H:%M") {
                    let ts = dt.and_utc().timestamp();
                    let entry = artist_last_scrobble.entry(artist_name.clone()).or_insert(0);
                    if ts > *entry { *entry = ts; }
                }
            }

            if *counter >= dynamic_threshold && !active_seeds_set.contains(&artist_name) {
                active_seeds_set.insert(artist_name.clone());
                active_seeds.push(artist_name);
            }

            if active_seeds.len() >= MAX_SEEDS { break; }
        }

        if active_seeds.len() >= MAX_SEEDS { break; }
        if page >= total_pages { break; }
        if page >= MAX_PAGES { break; }  // E1: hard cap to prevent timeout on large libraries
        page += 1;
    }

    println!("SEEDS COLLECTED: {} seeds across {} scrobble pages", active_seeds.len(), page);

    // A4: time-weighted seed scoring — recent listening is stronger discovery signal
    let now_ts = chrono::Utc::now().timestamp();
    let mut seed_weights: HashMap<String, f64> = HashMap::new();
    for name in &active_seeds {
        let plays = *artist_plays.get(name).unwrap_or(&dynamic_threshold);
        let base_multiplier = (plays as f64) / (dynamic_threshold as f64);
        let recency_mult = artist_last_scrobble.get(name)
            .map(|&last_ts| {
                let days_ago = (now_ts - last_ts).max(0) / 86400;
                if days_ago <= 30 { 2.0_f64 }
                else if days_ago <= 90 { 1.5_f64 }
                else { 1.0_f64 }
            })
            .unwrap_or(1.0);
        seed_weights.insert(name.clone(), base_multiplier * recency_mult);
    }

    // ── 1.5. Phase 5: Dual-graph — derive genre tags from top seeds, fetch tag-graph ──
    // Fetch artist info for the top 15 seeds by weight to extract their tags,
    // then pull tag.getTopArtists for the user's top 3 genres. Any candidate
    // that appears in BOTH the similar-artists graph AND the tag graph gets
    // cross_validated = true and a +0.5 flat conviction bonus.
    let tag_candidates: HashSet<String> = {
        let mut weighted_seeds: Vec<(&String, f64)> = seed_weights.iter()
            .map(|(k, &v)| (k, v))
            .collect();
        weighted_seeds.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        weighted_seeds.truncate(15);

        // Fetch artist info for top seeds to extract tags
        let seed_info_sem = Arc::new(Semaphore::new(5));
        let mut seed_info_futures = FuturesUnordered::new();
        for (name, _) in &weighted_seeds {
            let c = Arc::clone(&client);
            let n = (*name).clone();
            let u = username.clone();
            let sem = Arc::clone(&seed_info_sem);
            seed_info_futures.push(tokio::spawn(async move {
                let _permit = sem.acquire().await;
                c.fetch_artist_info(&n, &u).await
            }));
        }

        let mut tag_freq: HashMap<String, usize> = HashMap::new();
        while let Some(res) = seed_info_futures.next().await {
            if let Ok(Ok(info)) = res {
                if let Some(tags) = info.artist.tags {
                    for tag in tags.tag.iter().take(3) {
                        *tag_freq.entry(tag.name.to_lowercase()).or_insert(0) += 1;
                    }
                }
            }
        }

        let mut tag_freq_vec: Vec<(String, usize)> = tag_freq.into_iter().collect();
        tag_freq_vec.sort_by(|a, b| b.1.cmp(&a.1));
        let genre_tags: Vec<String> = tag_freq_vec.into_iter().take(3).map(|(t, _)| t).collect();
        println!("PHASE5: derived genre tags: {:?}", genre_tags);

        let mut tag_fetch_futures = FuturesUnordered::new();
        for tag in genre_tags {
            let c = Arc::clone(&client);
            tag_fetch_futures.push(tokio::spawn(async move {
                c.fetch_tag_top_artists(&tag, 100).await
            }));
        }

        let mut candidates = HashSet::new();
        while let Some(res) = tag_fetch_futures.next().await {
            if let Ok(Ok(artists)) = res {
                for a in artists {
                    candidates.insert(a.name.to_lowercase());
                }
            }
        }
        println!("PHASE5: {} tag-graph candidates ready for cross-validation", candidates.len());
        candidates
    };

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
                    // A3: cap per-seed contribution to prevent one dominant artist flooding the ranking
                    let capped_weight = weight.min(CONVICTION_CAP);
                    weighted_conviction += capped_weight;
                    source_seeds.push(crate::models::SourceSeed {
                        name: r.clone(),
                        percentile: capped_weight,
                    });
                }
            }

            // Phase 5: cross-validate against tag graph; flat +0.5 bonus if confirmed by both signals
            let cross_validated = tag_candidates.contains(&artist.name.to_lowercase());
            if cross_validated {
                weighted_conviction += 0.5;
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
                    cross_validated,
                    taste_alignment: 0.0,
                    velocity: None,
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

    let active_count = seed_weights.len();

    // A6/2.1: taste_alignment — tag overlap between discovered artist and user's genre profile
    let genre_weight_map: HashMap<String, f64> = top_genres.iter()
        .map(|g| (g.name.to_lowercase(), g.weight / 100.0))
        .collect();
    for artist in &mut obscure_artists {
        let alignment: f64 = artist.top_tags.iter()
            .map(|t| genre_weight_map.get(&t.to_lowercase()).copied().unwrap_or(0.0))
            .sum();
        artist.taste_alignment = (alignment / 5.0).min(1.0);
    }

    // A5: diversity enforcement — keep top 3 per conviction-weighted primary genre
    // Primary genre = whichever of the artist's tags has the highest weight in the user's profile
    let mut genre_slot_count: HashMap<String, usize> = HashMap::new();
    let diverse_artists: Vec<DiscoveryResponseItem> = obscure_artists
        .into_iter()
        .filter(|artist| {
            let primary_genre = artist.top_tags.iter()
                .max_by(|a, b| {
                    let wa = genre_weight_map.get(&a.to_lowercase()).copied().unwrap_or(0.0);
                    let wb = genre_weight_map.get(&b.to_lowercase()).copied().unwrap_or(0.0);
                    wa.partial_cmp(&wb).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|t| t.to_lowercase())
                .unwrap_or_else(|| "untagged".to_string());
            let count = genre_slot_count.entry(primary_genre).or_insert(0);
            if *count < 3 { *count += 1; true } else { false }
        })
        .collect();

    println!("DONE: {} artists after diversity pass ({} seeds)", diverse_artists.len(), active_count);

    // 2.2: depth score over final diverse set (absolute reference ceiling = log10(25001) ≈ 4.40)
    let depth_score = if diverse_artists.is_empty() {
        0.0
    } else {
        let ceiling = (25001_f64).log10();
        let total_weight: f64 = diverse_artists.iter().map(|a| a.composite_score).sum();
        if total_weight > 0.0 {
            let weighted_sum: f64 = diverse_artists.iter().map(|a| {
                let obscurity = ceiling - (a.total_listeners as f64 + 1.0).log10();
                obscurity.max(0.0) * a.composite_score
            }).sum();
            ((weighted_sum / total_weight) / ceiling * 100.0).min(100.0)
        } else {
            0.0
        }
    };

    let low_data_message = if active_count < 20 {
        Some("Your scrobble history is limited — results may include artists you already know. Deeper listening history improves accuracy.".to_string())
    } else {
        None
    };

    Ok(DiscoveryResponse {
        artists: diverse_artists,
        top_genres,
        deepest_date,
        active_seed_count: active_count,
        depth_score,
        message: low_data_message,
    })
}
