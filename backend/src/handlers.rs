// Discovery-pipeline HTTP surface: artist discovery, track discovery, the
// Spotify track lookup, and the opt-in Last.fm key-pool contribution. Split
// out from `api.rs` (which owns the Phase 1 identity/events/me/status
// surface) so each module tracks one slice of the API. Pure code motion from
// `main.rs` — no logic changes.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

use crate::api;
use crate::cache;
use crate::lastfm::LastfmClient;
use crate::models::{self, DiscoveryResponseItem};
use crate::pipeline::{discover_obscure_artists, discover_obscure_tracks};
use crate::spotify::SpotifyClient;
use crate::AppState;

// Last.fm usernames: letters, digits, hyphens, underscores, 2-15 chars
fn validate_username(username: &str) -> bool {
    let len = username.len();
    if len < 2 || len > 15 {
        return false;
    }
    username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Deserialize)]
pub(crate) struct DiscoveryQuery {
    period: String,
    username: String,
    /// Optional user-supplied Last.fm API key. When present, bypasses the
    /// server key and skips the cache (results are not stored server-side).
    api_key: Option<String>,
    /// Discovery-appetite slider: how much re-engagement to mix into discovery.
    /// new = brand-new only; low/balanced/high = resurface lightly-played obscure
    /// artists below mean-plays × {1,2,4}. Absent → balanced. See appetite_to_mult.
    appetite: Option<String>,
}

/// Map the discovery-appetite slider to the underexplored-novelty multiplier.
/// `None` = strict (recommend only never-played artists); `Some(m)` = the
/// recommendation threshold is the user's mean plays-per-artist × m, so more
/// lightly-played obscure artists get resurfaced as the appetite rises. Eval
/// (de-biased n=54) showed obscW rises monotonically with the multiplier, all of
/// it re-engagement; the slider hands that dial to the user. Balanced (2.0) is the
/// default and what the server ships when no appetite is given.
fn appetite_to_mult(appetite: Option<&str>) -> Option<f64> {
    match appetite.unwrap_or("balanced") {
        "new" => None,
        "low" => Some(1.0),
        "high" => Some(4.0),
        _ => Some(2.0), // "balanced" (and any unknown value) → the default
    }
}

/// What the result cache stores for a discovery run: the response (with rec_ids
/// + run_id already assigned when persistence is on) plus the post-diversity
/// reserve used to backfill the per-user dismissal filter on a cache hit. The
/// cached response is USER-AGNOSTIC (never dismissal-filtered); filtering is
/// applied per-request after retrieval.
#[derive(Serialize, Deserialize)]
struct CachedRun {
    response: models::DiscoveryResponse,
    #[serde(default)]
    reserve: Vec<DiscoveryResponseItem>,
}

type ApiResult = Result<Json<models::DiscoveryResponse>, (StatusCode, Json<models::ErrorResponse>)>;

pub async fn discovery_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DiscoveryQuery>,
) -> ApiResult {
    // S1: validate username before any API calls
    if !validate_username(&query.username) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(models::ErrorResponse {
                error: "Invalid username. Must be 2-15 alphanumeric, hyphen, or underscore characters.".into(),
                code: 400,
            }),
        ));
    }

    let custom_key = query.api_key.as_deref().filter(|k| !k.is_empty());
    // Count this discovery request; `used_pool` = it leaned on the shared server
    // key pool (no custom key). Pure bookkeeping — the response is unaffected.
    state.metrics.record_discovery(custom_key.is_none());
    let client: Arc<LastfmClient> = match custom_key {
        Some(key) => Arc::new(LastfmClient::new(key.to_string())),
        None => Arc::clone(&state.client),
    };

    let appetite = query.appetite.as_deref().unwrap_or("balanced");
    let appetite_mult = appetite_to_mult(query.appetite.as_deref());

    // Resolve the (optional) authenticated user once. Anonymous requests never
    // touch the DB (bearer is checked first inside resolve_auth).
    let authed = api::resolve_auth(&headers, &state.db).await;

    // Custom-key requests skip the cache and persistence — results aren't
    // stored server-side (unchanged behavior).
    if let Some(_) = custom_key {
        return match discover_obscure_artists(client, query.username, query.period, appetite_mult).await {
            Ok((result, _reserve)) => {
                let result = annotate_sparse_artists(result);
                let result = attach_listen_links(&state.spotify, result).await;
                Ok(Json(result))
            }
            Err(e) if e.to_string().contains("No listening history") => {
                Ok(Json(empty_discovery_response()))
            }
            Err(e) => {
                eprintln!("Discovery error (custom key): {}", e);
                Err((StatusCode::INTERNAL_SERVER_ERROR, Json(models::ErrorResponse {
                    error: format!("Discovery failed: {}", e),
                    code: 500,
                })))
            }
        };
    }

    let cache_key = format!("reverse_scrobble:{}:{}:{}", query.username, query.period, appetite);
    // ── Cache hit ────────────────────────────────────────────────────────────
    if let Some(cached) = state.cache.get_json::<CachedRun>(&cache_key).await {
        println!("Cache hit: {}", cache_key);
        let CachedRun { response, reserve } = cached;
        // Impression on cache-hit: the run happened once and is being re-served.
        // Enqueued OFF-path (try_send, never awaited) so cache-hit latency is
        // unchanged. No-op when persistence is off or the cached run predates it.
        if let (Some(db), Some(run_id_str)) = (&state.db, &response.run_id) {
            if let Ok(run_id) = Uuid::parse_str(run_id_str) {
                db.enqueue_impression(run_id);
            }
        }
        // Dismissal filter (authenticated only) — one small indexed read.
        let response = match (&state.db, &authed) {
            (Some(db), Some(user)) => {
                let dismissed = db.dismissed_norms(user.user_id).await;
                api::apply_dismissals(response, reserve, &dismissed)
            }
            _ => response,
        };
        return Ok(Json(response));
    }

    // ── Cache miss ───────────────────────────────────────────────────────────
    println!("Cache miss: {}", cache_key);
    match discover_obscure_artists(client, query.username.clone(), query.period.clone(), appetite_mult).await {
        Ok((result, mut reserve)) => {
            let mut result = annotate_sparse_artists(result);
            result = attach_listen_links(&state.spotify, result).await;
            attach_links_to_items(&state.spotify, &mut reserve).await;

            // Only persist/cache non-empty results; degraded/empty runs shouldn't stick.
            if !result.artists.is_empty() {
                // Assign run_id + rec_ids and spawn the run/recommendation/observation
                // writes OFF the response path when persistence is on.
                if let Some(db) = &state.db {
                    let run_id = Uuid::new_v4();
                    let (run, recs, obs) = api::prepare_persistence(
                        run_id,
                        authed.as_ref().map(|u| u.user_id),
                        &query.username,
                        &query.period,
                        appetite,
                        &mut result,
                        &mut reserve,
                    );
                    db.enqueue_run(run, recs, obs);
                }
                // Cache the UNFILTERED response (+reserve) — user-agnostic.
                let cached = CachedRun { response: result.clone(), reserve: reserve.clone() };
                state.cache
                    .put_json(&cache_key, &cached, Duration::from_secs(cache::DEFAULT_TTL_SECS))
                    .await;
            }

            // Dismissal filter (authenticated only), backfilled from the reserve.
            let result = match (&state.db, &authed) {
                (Some(db), Some(user)) => {
                    let dismissed = db.dismissed_norms(user.user_id).await;
                    api::apply_dismissals(result, reserve, &dismissed)
                }
                _ => result,
            };
            Ok(Json(result))
        }
        Err(e) if e.to_string().contains("No listening history") => {
            Ok(Json(empty_discovery_response()))
        }
        Err(e) => {
            eprintln!("Discovery error: {}", e);
            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(models::ErrorResponse {
                error: format!("Discovery failed: {}", e),
                code: 500,
            })))
        }
    }
}

/// When a discovery comes back sparse, attach a message so the UI explains the
/// near-empty page instead of rendering a blank. The common trigger is the
/// `overall` period: all-time top artists are too well-known, so their similar
/// artists get filtered by the obscurity ceiling and little survives. Recent
/// periods surface far more. Leaves an existing message (e.g. no-history) intact.
fn annotate_sparse_artists(mut result: models::DiscoveryResponse) -> models::DiscoveryResponse {
    const SPARSE_THRESHOLD: usize = 8;
    if result.message.is_none() && result.artists.len() < SPARSE_THRESHOLD {
        result.message = Some(format!(
            "Only {} obscure match{} for this period. All-time favourites tend to be too well-known to surface much; try a recent period (1 month or 3 month) for more discoveries.",
            result.artists.len(),
            if result.artists.len() == 1 { "" } else { "es" },
        ));
    }
    result
}

/// Resolve listen/find links (Spotify artist, "This Is" playlist, Bandcamp) for
/// every artist in the result and attach them in place. Best-effort: a missing
/// link just means the frontend hides that button. No-op when Spotify isn't
/// configured. Runs all artists concurrently — wall-clock ≈ one round-trip.
async fn attach_listen_links(
    spotify: &Option<Arc<SpotifyClient>>,
    mut result: models::DiscoveryResponse,
) -> models::DiscoveryResponse {
    attach_links_to_items(spotify, &mut result.artists).await;
    result
}

/// Resolve listen/find links for a slice of items in place (see
/// `attach_listen_links`). Used for both the visible list and the dismissal
/// reserve, so backfilled artists already carry their links (resolved once and
/// cached with the run). No-op when Spotify isn't configured or the slice is empty.
async fn attach_links_to_items(
    spotify: &Option<Arc<SpotifyClient>>,
    items: &mut [models::DiscoveryResponseItem],
) {
    let Some(spotify) = spotify else { return; };
    if items.is_empty() {
        return;
    }
    let lookups = items.iter().map(|a| {
        let spotify = Arc::clone(spotify);
        let name = a.name.clone();
        async move { spotify.resolve_artist_links(&name).await }
    });
    let links = futures::future::join_all(lookups).await;
    for (item, link) in items.iter_mut().zip(links) {
        item.spotify_url = link.spotify_url;
        item.this_is_url = link.this_is_url;
        item.bandcamp_url = link.bandcamp_url;
    }
}

/// A 200-OK empty artist-discovery response for the genuine "no history" case.
fn empty_discovery_response() -> models::DiscoveryResponse {
    models::DiscoveryResponse {
        artists: vec![],
        top_genres: vec![],
        deepest_date: None,
        active_seed_count: 0,
        depth_score: 0.0,
        message: Some("No listening history for this period. Try a different time range.".into()),
        run_id: None,
        persistence: false,
    }
}

type TrackApiResult = Result<Json<models::TrackDiscoveryResponse>, (StatusCode, Json<models::ErrorResponse>)>;

pub async fn track_discovery_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DiscoveryQuery>,
) -> TrackApiResult {
    if !validate_username(&query.username) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(models::ErrorResponse {
                error: "Invalid username.".into(),
                code: 400,
            }),
        ));
    }

    let custom_key = query.api_key.as_deref().filter(|k| !k.is_empty());
    // Count this track-discovery request (see discovery_handler).
    state.metrics.record_tracks(custom_key.is_none());
    let client: Arc<LastfmClient> = match custom_key {
        Some(key) => Arc::new(LastfmClient::new(key.to_string())),
        None => Arc::clone(&state.client),
    };

    if custom_key.is_none() {
        let cache_key = format!("tracks:{}:{}", query.username, query.period);
        if let Some(data) = state.cache.get_json::<models::TrackDiscoveryResponse>(&cache_key).await {
            return Ok(Json(data));
        }
        match discover_obscure_tracks(client, query.username, query.period).await {
            Ok(result) => {
                // Only cache non-empty results; degraded/empty runs shouldn't stick.
                if !result.tracks.is_empty() {
                    state.cache
                        .put_json(&cache_key, &result, Duration::from_secs(cache::DEFAULT_TTL_SECS))
                        .await;
                }
                Ok(Json(result))
            }
            Err(e) if e.to_string().contains("No track history")
                || e.to_string().contains("No listening history") =>
            {
                Ok(Json(empty_track_discovery_response()))
            }
            Err(e) => {
                eprintln!("Track discovery error: {}", e);
                Err((StatusCode::INTERNAL_SERVER_ERROR, Json(models::ErrorResponse {
                    error: format!("Track discovery failed: {}", e),
                    code: 500,
                })))
            }
        }
    } else {
        match discover_obscure_tracks(client, query.username, query.period).await {
            Ok(result) => Ok(Json(result)),
            Err(e) if e.to_string().contains("No track history")
                || e.to_string().contains("No listening history") =>
            {
                Ok(Json(empty_track_discovery_response()))
            }
            Err(e) => {
                eprintln!("Track discovery error (custom key): {}", e);
                Err((StatusCode::INTERNAL_SERVER_ERROR, Json(models::ErrorResponse {
                    error: format!("Track discovery failed: {}", e),
                    code: 500,
                })))
            }
        }
    }
}

/// A 200-OK empty track-discovery response for the genuine "no history" case.
fn empty_track_discovery_response() -> models::TrackDiscoveryResponse {
    models::TrackDiscoveryResponse {
        tracks: vec![],
        top_genres: vec![],
        active_seed_count: 0,
        depth_score: 0.0,
        message: Some("No track history for this period. Try a different time range.".into()),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct SpotifyTrackQuery {
    artist: String,
    track: String,
}

pub async fn spotify_track_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SpotifyTrackQuery>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Some(spotify) = &state.spotify else {
        return (
            StatusCode::NOT_FOUND,
            Json(models::ErrorResponse { error: "Spotify not configured".into(), code: 404 }),
        ).into_response();
    };
    match spotify.lookup_track(&query.artist, &query.track).await {
        Some(info) => Json(info).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(models::ErrorResponse { error: "Track not found on Spotify".into(), code: 404 }),
        ).into_response(),
    }
}

/// Opt-in: a user shares their Last.fm API key to the rotation pool to speed up
/// discovery for everyone. POST (not GET) so the key never lands in a URL/log.
/// The key is validated against Last.fm before being accepted.
#[derive(Deserialize)]
pub(crate) struct ContributeBody {
    api_key: String,
}

pub async fn contribute_key_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ContributeBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let key = body.api_key.trim().to_string();
    // Last.fm API keys are 32-char hex; accept a generous alnum range.
    if key.len() < 16 || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "invalid key format" })),
        );
    }
    // Validate with a cheap real call before trusting it in the pool.
    let probe = LastfmClient::new(key.clone());
    if probe.fetch_similar_artists("Radiohead", 1).await.is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "key failed Last.fm validation" })),
        );
    }
    match state.client.add_key(key) {
        Some(n) => {
            println!("Key pool grew to {} (user-contributed)", n);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true, "pool_size": n })))
        }
        None => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "duplicate": true, "pool_size": state.client.key_count() })),
        ),
    }
}
