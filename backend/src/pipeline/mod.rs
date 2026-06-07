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

pub async fn discover_obscure_artists(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<DiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let seeds = seeds::collect(&client, &username, &period_str).await?;
    let tag_candidates = tag_graph::fetch(&client, &username, &seeds).await;
    let candidate_map = candidates::build(&client, &seeds.names).await;
    scoring::score_and_rank(&client, &username, candidate_map, &seeds, &tag_candidates).await
}

pub async fn discover_obscure_tracks(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
) -> Result<TrackDiscoveryResponse, Box<dyn std::error::Error + Send + Sync>> {
    let seeds = track_seeds::collect(&client, &username, &period_str).await?;
    let candidate_map = track_candidates::build(&client, &seeds.entries).await;
    track_scoring::score_and_rank(&client, &username, candidate_map, &seeds).await
}
