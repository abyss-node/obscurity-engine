use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use tower_http::cors::CorsLayer;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

mod lastfm;
mod models;
mod service;

use lastfm::{LastfmClient, TimePeriod};
use service::discover_obscure_artists;

#[derive(Deserialize)]
struct DiscoveryQuery {
    period: String,
    username: String,
}

// Global thread-safe AppState holding our Client + Memory Cache
struct AppState {
    client: Arc<LastfmClient>,
    // Maps "username:period" -> (Timestamp, Results)
    cache: RwLock<HashMap<String, (Instant, models::DiscoveryResponse)>>,
}

async fn discovery_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DiscoveryQuery>,
) -> Json<models::DiscoveryResponse> {
    let cache_key = format!("reverse_scrobble:{}:{}", query.username, query.period);

    // 1. FAST RUST IN-MEMORY CACHE (1 Hour Expiry)
    {
        let cache = state.cache.read().await; // Acquire read lock
        if let Some((timestamp, data)) = cache.get(&cache_key) {
            if timestamp.elapsed() < Duration::from_secs(3600) {
                println!("Serving {} from cache hits!", cache_key);
                return Json(data.clone());
            }
        }
    } // Read lock explicitly dropped

    // 2. FETCH VIA SERVICE PIPELINE
    println!("Cache Miss/Expired for {}, querying Last.fm...", cache_key);
    match discover_obscure_artists(Arc::clone(&state.client), query.username, query.period).await {
        Ok(artists) => {
            // Write to cache
            let mut cache = state.cache.write().await; // Acquire write lock safely
            cache.insert(cache_key, (Instant::now(), artists.clone()));
            Json(artists)
        }
        Err(e) => {
            eprintln!("Error discovering artists: {}", e);
            Json(models::DiscoveryResponse { artists: vec![], top_genres: vec![], deepest_date: None, active_seed_count: 0 })
        }
    }
}

#[tokio::main]
async fn main() {
    // Load variables from .env file explicitly
    dotenvy::dotenv().ok();

    let api_key = std::env::var("LASTFM_API_KEY").unwrap_or_else(|_| "DEMO_KEY".to_string());
    
    // PORT binding dynamically fetches environmental variables for strict render/railway compliance
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let state = Arc::new(AppState {
        client: Arc::new(LastfmClient::new(api_key)),
        cache: RwLock::new(HashMap::new()),
    });

    // Load dynamic production CORS, defaulting gracefully back to Localhost
    let frontend_url = std::env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/", get(|| async { "ObscurityEngine Backend Alive!" }))
        .route("/api/discovery", get(discovery_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Server bound perfectly and listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}
