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
// pub(crate) (not private like the other stages) so main.rs's integration tests
// can exercise seeds::collect / Seeds directly for the "ytd" period, without
// standing up a full discovery run.
pub(crate) mod seeds;
mod tag_graph;
mod track_candidates;
mod track_scoring;
mod track_seeds;

use std::sync::Arc;
use crate::lastfm::LastfmClient;
use crate::listenbrainz::{CandidateSource, ListenBrainzClient};
use crate::models::{DiscoveryResponse, DiscoveryResponseItem, TrackDiscoveryResponse};

/// Everything the candidate seam needs to blend in the ListenBrainz source.
/// Passed as `Some(..)` only when `CANDIDATE_SOURCE` selects a non-`lastfm`
/// source; `None` (or `source == Lastfm`) runs the Last.fm-only path unchanged.
/// All fields are borrows — the struct is `Copy`, so both handler call sites can
/// pass it without cloning.
#[derive(Clone, Copy)]
pub struct BlendConfig<'a> {
    pub source: CandidateSource,
    pub listenbrainz: &'a ListenBrainzClient,
    pub cache: &'a crate::cache::CacheStore,
    pub metrics: &'a crate::metrics::Metrics,
}

/// Shared listener-count ceiling: candidates (artist- or track-level) above this
/// are considered too mainstream to surface, and it's also the denominator in
/// both depth-score obscurity curves (see scoring.rs / track_scoring.rs
/// `compute_depth_score`). Previously defined twice (25_000 in both files);
/// unified here so the two pipelines can never drift apart. Value unchanged.
pub const MAX_LISTENER_CEILING: u64 = 25_000;

pub async fn discover_obscure_artists(
    client: Arc<LastfmClient>,
    username: String,
    period_str: String,
    // Discovery-appetite multiplier (from the slider, mapped in main.rs):
    // `None` = strict (recommend only never-played artists); `Some(m)` = the
    // recommendation threshold is the user's lifetime mean plays-per-artist × m, so
    // more lightly-played obscure artists are resurfaced as the appetite rises.
    // Eval (de-biased n=54, 2026-06-21): obscW rises monotonically with m, all of it
    // re-engagement; new discovery is reach-capped by Last.fm's graph (see roadmap).
    appetite_mult: Option<f64>,
    // Candidate-source blend config. `None` = today's Last.fm-only behavior
    // (byte-identical). `Some(..)` blends in ListenBrainz per `CANDIDATE_SOURCE`.
    blend: Option<BlendConfig<'_>>,
    // Returns the response (top 25, unchanged) plus the post-diversity reserve
    // (26+) used only to backfill the authenticated dismissal filter.
) -> Result<(DiscoveryResponse, Vec<DiscoveryResponseItem>), Box<dyn std::error::Error + Send + Sync>> {
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
    // total_scrobbles has the analogous ytd-only fallback: seeds.total_scrobbles is
    // None for every period except ytd, so this is additive-only for everything else.
    let user_info = client.fetch_user_info(&username).await.ok().map(|u| u.user);
    let total_scrobbles = user_info.as_ref()
        .and_then(|u| u.playcount.as_ref())
        .and_then(|p| p.parse::<f64>().ok())
        .or_else(|| seeds.total_scrobbles.map(|s| s as f64));
    let distinct_artists = user_info.as_ref()
        .and_then(|u| u.artist_count.as_ref())
        .and_then(|a| a.parse::<u64>().ok())
        .or(seeds.total_artist_count);
    // None appetite (slider = "new") → strict, recommend only never-played artists.
    // Some(mult) → mean plays-per-artist × mult is the light/deep cutoff.
    let under_threshold: Option<u64> = match appetite_mult {
        Some(mult) => match (total_scrobbles, distinct_artists) {
            (Some(plays), Some(artists)) if artists > 0 => {
                Some(((plays / artists as f64) * mult).round() as u64)
            }
            _ => None,
        },
        None => None,
    };
    println!(
        "UNDEREXPLORED: threshold={:?} (scrobbles={:?}, artists={:?})",
        under_threshold, total_scrobbles, distinct_artists
    );

    let tag_candidates = tag_graph::fetch(&client, &username, &seeds).await?;
    let candidate_map = candidates::build_candidates(&client, &seeds.names, blend.as_ref()).await?;
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
