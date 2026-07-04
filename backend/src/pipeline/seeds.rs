/// Phase 1: collect seed artists from the user's Last.fm history.
///
/// "Seeds" are the user's most-listened artists, used as the starting points
/// for the discovery graph traversal in subsequent phases.
///
/// Two collection strategies:
/// - "blend" mode: fetches all 6 time windows in parallel, normalises
///   each window's playcounts to a per-week rate, and merges them so that
///   recent listening weighs more heavily than historical plays.
/// - single-period mode: one gettopartists call, weighted by log2(playcount).
use std::collections::HashMap;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use crate::lastfm::{LastfmClient, TimePeriod, is_transient_error, is_user_not_found_error};
use crate::utils::parse_period;

const MAX_SEEDS: usize = 100;

pub struct Seeds {
    /// artist_name → blended weight (higher = stronger taste signal)
    pub weights: HashMap<String, f64>,
    /// Ordered by weight, descending — preserves iteration order for Phase 2
    pub names: Vec<String>,
    /// User's total distinct artist count (from gettopartists @attr.total).
    /// Used to compute the underexplored-novelty threshold. None if unavailable.
    pub total_artist_count: Option<u64>,
}

pub async fn collect(
    client: &Arc<LastfmClient>,
    username: &str,
    period_str: &str,
) -> Result<Seeds, Box<dyn std::error::Error + Send + Sync>> {
    if period_str == "blend" {
        collect_blend(client, username).await
    } else {
        collect_single(client, username, period_str).await
    }
}

/// Fetches all 6 time windows concurrently.
/// Each window is weighted by 7/days so playcounts normalise to "plays per week"
/// before being summed — preventing the "overall" window (years of data) from
/// drowning out the recency signal from the 7-day window.
async fn collect_blend(
    client: &Arc<LastfmClient>,
    username: &str,
) -> Result<Seeds, Box<dyn std::error::Error + Send + Sync>> {
    let blend_periods: [(TimePeriod, f64); 6] = [
        (TimePeriod::SevenDay,    1.0),
        (TimePeriod::OneMonth,    7.0 / 30.0),
        (TimePeriod::ThreeMonth,  7.0 / 90.0),
        (TimePeriod::SixMonth,    7.0 / 180.0),
        (TimePeriod::TwelveMonth, 7.0 / 365.0),
        (TimePeriod::Overall,     7.0 / 1095.0),
    ];

    let mut period_futures = FuturesUnordered::new();
    for (period, factor) in &blend_periods {
        let client = Arc::clone(client);
        let username = username.to_string();
        let period = *period;
        let factor = *factor;
        period_futures.push(tokio::spawn(async move {
            let result = client.fetch_user_top_artists(&username, 200, period).await;
            (result, factor)
        }));
    }

    let mut merged: HashMap<String, f64> = HashMap::new();
    // Track the largest @attr.total across all windows. The Overall window has the
    // most distinct artists, so its total is the lifetime distinct-artist count.
    let mut max_total: Option<u64> = None;
    while let Some(task_result) = period_futures.next().await {
        match task_result {
            Ok((Ok(response), factor)) => {
                if let Some(attr) = response.topartists.attr.as_ref() {
                    if let Ok(total) = attr.total.parse::<u64>() {
                        max_total = Some(max_total.map_or(total, |m| m.max(total)));
                    }
                }
                for artist in response.topartists.artist.into_iter().take(MAX_SEEDS) {
                    let plays = artist.playcount.as_ref()
                        .and_then(|p| p.parse::<f64>().ok())
                        .unwrap_or(1.0)
                        .max(1.0);
                    // log2 compresses the range so a 10,000-play artist
                    // doesn't completely overshadow a 100-play one
                    *merged.entry(artist.name).or_insert(0.0) += plays.log2().max(1.0) * factor;
                }
            }
            // A transient failure on any window would silently drop its recency
            // signal and reshape the whole seed set — fail-closed instead.
            Ok((Err(e), _factor)) => {
                if is_transient_error(e.as_ref()) {
                    return Err(format!("top-artists window fetch failed: {}", e).into());
                }
                eprintln!("BLEND: skipping a window (permanent error: {})", e);
            }
            Err(e) => return Err(format!("top-artists window task failed: {}", e).into()),
        }
    }

    let mut sorted: Vec<(String, f64)> = merged.into_iter().collect();
    // Tiebreak by name so equal-weight seeds at the truncation boundary are stable.
    sorted.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    sorted.truncate(MAX_SEEDS);

    if sorted.is_empty() {
        return Err("No listening history found for this user.".into());
    }

    let mut weights = HashMap::new();
    let mut names = Vec::new();
    for (name, weight) in sorted {
        weights.insert(name.clone(), weight);
        names.push(name);
    }

    println!("BLEND: {} merged seeds across all periods", names.len());
    Ok(Seeds { weights, names, total_artist_count: max_total })
}

async fn collect_single(
    client: &Arc<LastfmClient>,
    username: &str,
    period_str: &str,
) -> Result<Seeds, Box<dyn std::error::Error + Send + Sync>> {
    let period = parse_period(period_str);
    let response = client
        .fetch_user_top_artists(username, 200, period)
        .await
        .map_err(|e| {
            // A "user not found" error is permanent and user-facing on its own
            // terms — propagate it unchanged (preserving downcastability) so
            // the handler can surface a 404 instead of folding it into the
            // generic "Failed to fetch..." string every other error gets.
            if is_user_not_found_error(e.as_ref()) {
                e
            } else {
                format!("Failed to fetch top artists: {}", e).into()
            }
        })?;

    // Read the distinct-artist total before consuming the artist vec.
    let total_artist_count = response.topartists.attr.as_ref()
        .and_then(|a| a.total.parse::<u64>().ok());

    let top_artists = response.topartists.artist;
    if top_artists.is_empty() {
        return Err("No listening history found for this user.".into());
    }

    let mut weights = HashMap::new();
    let mut names = Vec::new();
    for artist in top_artists.into_iter().take(MAX_SEEDS) {
        let plays = artist.playcount.as_ref()
            .and_then(|p| p.parse::<f64>().ok())
            .unwrap_or(1.0)
            .max(1.0);
        weights.insert(artist.name.clone(), plays.log2().max(1.0));
        names.push(artist.name);
    }

    println!("SEEDS: {} seeds from user.gettopartists ({})", names.len(), period_str);
    Ok(Seeds { weights, names, total_artist_count })
}
