// obscurity-engine backend — Axum HTTP server (deployed to Railway).
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

mod lastfm;
mod models;
mod pipeline;
mod spotify;
mod utils;

use lastfm::LastfmClient;
use spotify::SpotifyClient;
use pipeline::{discover_obscure_artists, discover_obscure_tracks};

// Last.fm usernames: letters, digits, hyphens, underscores, 2-15 chars
fn validate_username(username: &str) -> bool {
    let len = username.len();
    if len < 2 || len > 15 {
        return false;
    }
    username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Deserialize)]
struct DiscoveryQuery {
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

struct AppState {
    client: Arc<LastfmClient>,
    spotify: Option<Arc<SpotifyClient>>,
    cache: RwLock<HashMap<String, (Instant, models::DiscoveryResponse)>>,
    track_cache: RwLock<HashMap<String, (Instant, models::TrackDiscoveryResponse)>>,
}

type ApiResult = Result<Json<models::DiscoveryResponse>, (StatusCode, Json<models::ErrorResponse>)>;

async fn discovery_handler(
    State(state): State<Arc<AppState>>,
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
    let client: Arc<LastfmClient> = match custom_key {
        Some(key) => Arc::new(LastfmClient::new(key.to_string())),
        None => Arc::clone(&state.client),
    };

    let appetite = query.appetite.as_deref().unwrap_or("balanced");
    let appetite_mult = appetite_to_mult(query.appetite.as_deref());

    // Custom-key requests skip the cache — results aren't stored server-side.
    if custom_key.is_none() {
        let cache_key = format!("reverse_scrobble:{}:{}:{}", query.username, query.period, appetite);
        {
            let cache = state.cache.read().await;
            if let Some((timestamp, data)) = cache.get(&cache_key) {
                if timestamp.elapsed() < Duration::from_secs(3600) {
                    println!("Cache hit: {}", cache_key);
                    return Ok(Json(data.clone()));
                }
            }
        }
        println!("Cache miss: {}", cache_key);
        match discover_obscure_artists(client, query.username, query.period, appetite_mult).await {
            Ok(result) => {
                let result = annotate_sparse_artists(result);
                let result = attach_listen_links(&state.spotify, result).await;
                // Only cache non-empty results; degraded/empty runs shouldn't stick.
                if !result.artists.is_empty() {
                    let mut cache = state.cache.write().await;
                    cache.insert(cache_key, (Instant::now(), result.clone()));
                }
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
    } else {
        match discover_obscure_artists(client, query.username, query.period, appetite_mult).await {
            Ok(result) => {
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
    // Only Spotify links need server-side resolution and that needs creds;
    // Last.fm/Bandcamp are built client-side. No Spotify client → nothing to do.
    let Some(spotify) = spotify else { return result; };
    if result.artists.is_empty() {
        return result;
    }
    let lookups = result.artists.iter().map(|a| {
        let spotify = Arc::clone(spotify);
        let name = a.name.clone();
        async move { spotify.resolve_artist_links(&name).await }
    });
    let links = futures::future::join_all(lookups).await;
    for (item, link) in result.artists.iter_mut().zip(links) {
        item.spotify_url = link.spotify_url;
        item.this_is_url = link.this_is_url;
        item.bandcamp_url = link.bandcamp_url;
    }
    result
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
    }
}

type TrackApiResult = Result<Json<models::TrackDiscoveryResponse>, (StatusCode, Json<models::ErrorResponse>)>;

async fn track_discovery_handler(
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
    let client: Arc<LastfmClient> = match custom_key {
        Some(key) => Arc::new(LastfmClient::new(key.to_string())),
        None => Arc::clone(&state.client),
    };

    if custom_key.is_none() {
        let cache_key = format!("tracks:{}:{}", query.username, query.period);
        {
            let cache = state.track_cache.read().await;
            if let Some((timestamp, data)) = cache.get(&cache_key) {
                if timestamp.elapsed() < Duration::from_secs(3600) {
                    return Ok(Json(data.clone()));
                }
            }
        }
        match discover_obscure_tracks(client, query.username, query.period).await {
            Ok(result) => {
                // Only cache non-empty results; degraded/empty runs shouldn't stick.
                if !result.tracks.is_empty() {
                    let mut cache = state.track_cache.write().await;
                    cache.insert(cache_key, (Instant::now(), result.clone()));
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
struct SpotifyTrackQuery {
    artist: String,
    track: String,
}

async fn spotify_track_handler(
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
struct ContributeBody {
    api_key: String,
}

async fn contribute_key_handler(
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

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    // Key pool: prefer a comma-separated LASTFM_API_KEYS (owner keys), fall back
    // to the single LASTFM_API_KEY. User-shared keys are added at runtime via
    // POST /api/keys. More keys = more aggregate Last.fm rate limit = faster
    // cold computes and fewer Error-29 failures.
    let api_keys: Vec<String> = std::env::var("LASTFM_API_KEYS")
        .ok()
        .map(|s| s.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect::<Vec<_>>())
        .filter(|v: &Vec<String>| !v.is_empty())
        .or_else(|| std::env::var("LASTFM_API_KEY").ok().map(|k| vec![k]))
        .unwrap_or_else(|| vec!["DEMO_KEY".to_string()]);
    println!("Last.fm key pool: {} key(s)", api_keys.len());
    // Optional persistence for user-contributed keys (set KEY_STORE_PATH to a
    // file on a Railway Volume so the opt-in pool survives redeploys).
    let key_store = std::env::var("KEY_STORE_PATH").ok().filter(|s| !s.is_empty()).map(std::path::PathBuf::from);
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let spotify = match (
        std::env::var("SPOTIFY_CLIENT_ID"),
        std::env::var("SPOTIFY_CLIENT_SECRET"),
    ) {
        (Ok(id), Ok(secret)) => {
            println!("Spotify credentials loaded — preview endpoint enabled");
            Some(Arc::new(SpotifyClient::new(id, secret)))
        }
        _ => {
            println!("Spotify credentials not set — /api/spotify/track will return 404");
            None
        }
    };

    let state = Arc::new(AppState {
        client: Arc::new(LastfmClient::with_keys(api_keys, key_store)),
        spotify,
        cache: RwLock::new(HashMap::new()),
        track_cache: RwLock::new(HashMap::new()),
    });

    // B2: CORS — use FRONTEND_URL env var; fall back to any localhost in dev
    let cors = match std::env::var("FRONTEND_URL") {
        Ok(url) => match url.parse::<axum::http::HeaderValue>() {
            Ok(origin) => CorsLayer::new()
                .allow_origin(AllowOrigin::exact(origin))
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
            Err(_) => {
                eprintln!("Warning: FRONTEND_URL is not a valid header value — allowing any origin in dev");
                CorsLayer::new()
                    .allow_origin(tower_http::cors::Any)
                    .allow_methods(tower_http::cors::Any)
                    .allow_headers(tower_http::cors::Any)
            }
        },
        Err(_) => CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any),
    };

    let app = Router::new()
        .route("/", get(|| async { "ObscurityEngine Backend Alive!" }))
        .route("/api/discovery", get(discovery_handler))
        .route("/api/discovery/tracks", get(track_discovery_handler))
        .route("/api/spotify/track", get(spotify_track_handler))
        .route("/api/keys", post(contribute_key_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}
