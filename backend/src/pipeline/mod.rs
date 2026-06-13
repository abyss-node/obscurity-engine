/// The discovery pipeline.
///
/// Orchestrates four sequential stages to turn a Last.fm username into
/// a ranked list of obscure artists the user hasn't heard yet:
///
///   1. seeds.rs      — fetch the user's top artists across time windows
///   2. tag_graph.rs  — build a second signal from Last.fm genre tags
///   3. candidates.rs — expand each seed to its similar-artist neighbourhood
///   4. scoring.rs    — score, filter, diversify, and rank candidates
///
/// Each stage is self-contained: read the file for that phase to understand
/// what it does and which constants control its behaviour.
mod candidates;
mod scoring;
mod seeds;
mod tag_graph;
mod track_candidates;
mod track_scoring;
mod track_seeds;

use std::sync::Arc;
use crate::lastfm::LastfmClient;
use crate::models::{DiscoveryResponse, TrackDiscoveryResponse};

/// Underexplored-novelty multiplier. The recommendation threshold is the user's
/// lifetime mean plays-per-artist × this multiplier; artists played fewer times
/// than the threshold (including never) are recommendable, deeper ones excluded.
/// The eval harness confirmed 1.0 is optimal (0.5 only lost hits).
const UNDEREXPLORED_MULT: f64 = 1.0;

pub async fn discover_obscure_artists(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let seeds = seeds::collect(&client, &username, &period_str).await?;

    // Underexplored-novelty threshold: lifetime mean plays-per-artist × mult.
    // Lightly-played artists (below the threshold) are recommendable; deeper ones
    // are excluded. Falls back to strict (exclude any played artist) if either the
    // user.getinfo call or the distinct-artist count is unavailable.
    //
    // Both inputs must be LIFETIME to stay consistent with the lifetime
    // userplaycount used for exclusion. Scrobbles come from user.getinfo (lifetime).
    // For the distinct-artist count we prefer user.getinfo's lifetime artist_count
    // and fall back to the seed-window gettopartists @attr.total — the fallback is
    // only lifetime-accurate for the "blend"/"overall" periods, so preferring
    // artist_count keeps the threshold correct for windowed periods (7day..12month).
    let user_info = client.fetch_user_info(&username).await.ok().map(|u| u.user);
    let total_scrobbles = user_info.as_ref()
        .and_then(|u| u.playcount.as_ref())
        .and_then(|p| p.parse::<f64>().ok());
    let distinct_artists = user_info.as_ref()
        .and_then(|u| u.artist_count.as_ref())
        .and_then(|a| a.parse::<u64>().ok())
        .or(seeds.total_artist_count);
    let under_threshold: Option<u64> = match (total_scrobbles, distinct_artists) {
        (Some(plays), Some(artists)) if artists > 0 => {
            Some(((plays / artists as f64) * UNDEREXPLORED_MULT).round() as u64)
        }
        _ => None,
    };
    println!(
        "UNDEREXPLORED: threshold={:?} (scrobbles={:?}, artists={:?})",
        under_threshold, total_scrobbles, distinct_artists
    );

    let tag_candidates = tag_graph::fetch(&client, &username, &seeds).await;
    let candidate_map = candidates::build(&client, &seeds.names).await;
    scoring::score_and_rank(&client, &username, candidate_map, &seeds, &tag_candidates, under_threshold).await
}

pub async fn discover_obscure_tracks(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<TrackDiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let seeds = track_seeds::collect(&client, &username, &period_str).await?;
    let (candidate_map, total_seed_artists) = track_candidates::build(&client, &seeds).await;
    if candidate_map.is_empty() {
        return Err("No track candidates found — try a different time period or check your Last.fm history.".into());
    }
    track_scoring::score_and_rank(&client, &username, candidate_map, total_seed_artists, &seeds).await
}
