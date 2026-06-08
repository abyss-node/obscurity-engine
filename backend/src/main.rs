use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
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

    let cache_key = format!("reverse_scrobble:{}:{}", query.username, query.period);

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
    match discover_obscure_artists(Arc::clone(&state.client), query.username, query.period).await {
        Ok(result) => {
            let mut cache = state.cache.write().await;
            cache.insert(cache_key, (Instant::now(), result.clone()));
            Ok(Json(result))
        }
        Err(e) => {
            eprintln!("Discovery error: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(models::ErrorResponse {
                    error: format!("Discovery failed: {}", e),
                    code: 500,
                }),
            ))
        }
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

    let cache_key = format!("tracks:{}:{}", query.username, query.period);

    {
        let cache = state.track_cache.read().await;
        if let Some((timestamp, data)) = cache.get(&cache_key) {
            if timestamp.elapsed() < Duration::from_secs(3600) {
                return Ok(Json(data.clone()));
            }
        }
    }

    let spotify = match &state.spotify {
        Some(s) => Arc::clone(s),
        None => return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(models::ErrorResponse {
                error: "Track discovery requires Spotify credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.".into(),
                code: 503,
            }),
        )),
    };

    match discover_obscure_tracks(Arc::clone(&state.client), spotify, query.username, query.period).await {
        Ok(result) => {
            let mut cache = state.track_cache.write().await;
            cache.insert(cache_key, (Instant::now(), result.clone()));
            Ok(Json(result))
        }
        Err(e) => {
            eprintln!("Track discovery error: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(models::ErrorResponse {
                    error: format!("Track discovery failed: {}", e),
                    code: 500,
                }),
            ))
        }
    }
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let api_key = std::env::var("LASTFM_API_KEY").unwrap_or_else(|_| "DEMO_KEY".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let spotify = match (
        std::env::var("SPOTIFY_CLIENT_ID"),
        std::env::var("SPOTIFY_CLIENT_SECRET"),
    ) {
        (Ok(id), Ok(secret)) => {
            println!("Spotify credentials loaded — track discovery enabled");
            Some(Arc::new(SpotifyClient::new(id, secret)))
        }
        _ => {
            println!("Warning: SPOTIFY_CLIENT_ID/SECRET not set — track discovery disabled");
            None
        }
    };

    let state = Arc::new(AppState {
        client: Arc::new(LastfmClient::new(api_key)),
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
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}
