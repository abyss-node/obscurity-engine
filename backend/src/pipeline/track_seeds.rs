/// Phase 1 (track mode): collect seed tracks from the user's Last.fm history.
use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use crate::lastfm::{LastfmClient, TimePeriod, is_user_not_found_error};
use crate::utils::parse_period;

const MAX_SEEDS: usize = 200;

pub struct TrackSeeds {
    /// "artist::track" → blended weight
    pub weights: HashMap<String, f64>,
    /// Ordered by weight descending; each entry is (artist, track_name)
    pub entries: Vec<(String, String)>,
}

pub async fn collect(
    client: &Arc<LastfmClient>,
    username: &str,
    period_str: &str,
) -> Result<TrackSeeds, Box<dyn std::error::Error + Send + Sync>> {
    if period_str == "blend" {
        collect_blend(client, username).await
    } else {
        collect_single(client, username, period_str).await
    }
}

async fn collect_blend(
    client: &Arc<LastfmClient>,
    username: &str,
) -> Result<TrackSeeds, Box<dyn std::error::Error + Send + Sync>> {
    let blend_periods: [(TimePeriod, f64); 6] = [
        (TimePeriod::SevenDay,    1.0),
        (TimePeriod::OneMonth,    7.0 / 30.0),
        (TimePeriod::ThreeMonth,  7.0 / 90.0),
        (TimePeriod::SixMonth,    7.0 / 180.0),
        (TimePeriod::TwelveMonth, 7.0 / 365.0),
        (TimePeriod::Overall,     7.0 / 1095.0),
    ];

    let mut futures = FuturesUnordered::new();
    for (period, factor) in &blend_periods {
        let client = Arc::clone(client);
        let username = username.to_string();
        let period = *period;
        let factor = *factor;
        futures.push(tokio::spawn(async move {
            let result = client.fetch_user_top_tracks(&username, 100, period).await;
            (result, factor)
        }));
    }

    let mut merged: HashMap<String, (String, String, f64)> = HashMap::new();
    while let Some(task_result) = futures.next().await {
        if let Ok((Ok(response), factor)) = task_result {
            for track in response.toptracks.track.into_iter() {
                let plays = track.playcount.as_ref()
                    .and_then(|p| p.parse::<f64>().ok())
                    .unwrap_or(1.0)
                    .max(1.0);
                let key = seed_key(&track.artist.name, &track.name);
                let entry = merged.entry(key).or_insert_with(|| (track.artist.name.clone(), track.name.clone(), 0.0));
                entry.2 += plays.log2().max(1.0) * factor;
            }
        }
    }

    build_seeds(merged)
}

async fn collect_single(
    client: &Arc<LastfmClient>,
    username: &str,
    period_str: &str,
) -> Result<TrackSeeds, Box<dyn std::error::Error + Send + Sync>> {
    let period = parse_period(period_str);
    let response = client
        .fetch_user_top_tracks(username, 100, period)
        .await
        .map_err(|e| {
            // A "user not found" error is permanent and user-facing on its own
            // terms — propagate it unchanged (preserving downcastability) so
            // the handler can surface a 404 instead of folding it into the
            // generic "Failed to fetch..." string every other error gets.
            if is_user_not_found_error(e.as_ref()) {
                e
            } else {
                format!("Failed to fetch top tracks: {}", e).into()
            }
        })?;

    if response.toptracks.track.is_empty() {
        return Err("No track history found for this user.".into());
    }

    let mut merged: HashMap<String, (String, String, f64)> = HashMap::new();
    for track in response.toptracks.track.into_iter() {
        let plays = track.playcount.as_ref()
            .and_then(|p| p.parse::<f64>().ok())
            .unwrap_or(1.0)
            .max(1.0);
        let key = seed_key(&track.artist.name, &track.name);
        merged.insert(key, (track.artist.name, track.name, plays.log2().max(1.0)));
    }

    build_seeds(merged)
}

fn build_seeds(merged: HashMap<String, (String, String, f64)>) -> Result<TrackSeeds, Box<dyn std::error::Error + Send + Sync>> {
    let mut sorted: Vec<(String, String, String, f64)> = merged
        .into_iter()
        .map(|(key, (artist, track, w))| (key, artist, track, w))
        .collect();
    sorted.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(MAX_SEEDS);

    if sorted.is_empty() {
        return Err("No track history found for this user.".into());
    }

    let mut weights = HashMap::new();
    let mut entries = Vec::new();
    for (key, artist, track, weight) in sorted {
        weights.insert(key, weight);
        entries.push((artist, track));
    }

    println!("TRACK_SEEDS: {} seeds", entries.len());
    Ok(TrackSeeds { weights, entries })
}

pub fn seed_key(artist: &str, track: &str) -> String {
    format!("{}::{}", artist.to_lowercase(), track.to_lowercase())
}
