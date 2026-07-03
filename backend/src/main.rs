// obscurity-engine backend — Axum HTTP server (deployed to Railway).
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

mod api;
mod auth;
mod cache;
mod db;
mod lastfm;
mod metrics;
mod models;
mod pipeline;
mod ratelimit;
mod spotify;
mod utils;

use lastfm::LastfmClient;
use models::DiscoveryResponseItem;
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

pub struct AppState {
    pub client: Arc<LastfmClient>,
    pub spotify: Option<Arc<SpotifyClient>>,
    // Result cache — in-memory by default, Redis-backed when REDIS_URL is set.
    // Keys are namespaced by the callers (`reverse_scrobble:…`, `tracks:…`).
    pub cache: cache::CacheStore,
    // Always-on request counters. Incremented once per handled request; never
    // touch a response. Summarised to the log hourly and at shutdown.
    pub metrics: Arc<metrics::Metrics>,
    // Postgres persistence. `None` when DATABASE_URL is unset (graceful
    // fallback: every feature below hides/no-ops and discovery is unchanged).
    pub db: Option<Arc<db::Db>>,
    // Whether DATABASE_URL / REDIS_URL were set at boot — lets /api/status tell
    // "disabled" (unset) apart from "error" (set-but-unreachable).
    pub db_configured: bool,
    pub redis_configured: bool,
    // Last.fm shared secret for auth.getSession signing. `None` → login is off
    // (POST /api/auth/session returns 503 and the frontend hides the entry).
    pub lastfm_secret: Option<String>,
    // Per-IP token bucket for the write API.
    pub rate_limiter: Arc<ratelimit::RateLimiter>,
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

async fn discovery_handler(
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

/// Build the application router (all routes wired to `AppState`). Extracted so
/// integration tests can construct the exact same app; `main` layers CORS on top.
pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(|| async { "ObscurityEngine Backend Alive!" }))
        .route("/api/discovery", get(discovery_handler))
        .route("/api/discovery/tracks", get(track_discovery_handler))
        .route("/api/spotify/track", get(spotify_track_handler))
        .route("/api/keys", post(contribute_key_handler))
        // ── Phase 1: identity + events + me/* + status ──────────────────────
        .route(
            "/api/auth/session",
            post(api::auth_session_handler).delete(api::auth_logout_handler),
        )
        .route("/api/events", post(api::events_handler))
        .route("/api/me/saved", get(api::me_saved_handler))
        .route(
            "/api/me/data",
            get(api::me_data_handler).delete(api::me_data_delete_handler),
        )
        .route("/api/status", get(api::status_handler))
        .with_state(state)
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

    // Postgres persistence (Phase 1). `None` when DATABASE_URL is unset — the
    // server then behaves exactly as before (graceful fallback). `db_configured`
    // records whether the var was set so /api/status can tell "disabled" (unset)
    // from "error" (set but unreachable).
    let db_configured = std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty()).is_some();
    let db = db::Db::connect().await.map(Arc::new);
    if !db_configured {
        println!("Persistence: disabled (DATABASE_URL not set)");
    }

    // Last.fm auth signing secret. Without it, POST /api/auth/session 503s and
    // the frontend hides the login entry.
    let lastfm_secret = std::env::var("LASTFM_API_SECRET").ok().filter(|s| !s.is_empty());
    match &lastfm_secret {
        Some(_) => println!("Last.fm auth: enabled (LASTFM_API_SECRET set)"),
        None => println!("Last.fm auth: disabled (LASTFM_API_SECRET not set)"),
    }

    let redis_configured = std::env::var("REDIS_URL").ok().filter(|s| !s.is_empty()).is_some();

    // Select the cache backend: Redis when REDIS_URL is set (degrades to a miss
    // if Redis is unreachable), in-memory otherwise. Log the active store.
    let cache_store = match std::env::var("REDIS_URL").ok().filter(|s| !s.is_empty()) {
        Some(url) => match cache::RedisStore::new(&url) {
            Ok(store) => {
                if store.ping().await {
                    println!("Cache store: Redis (REDIS_URL set, connected)");
                } else {
                    println!("Cache store: Redis (REDIS_URL set, currently unreachable — will degrade to cache miss until it recovers)");
                }
                cache::CacheStore::Redis(store)
            }
            Err(e) => {
                eprintln!("REDIS_URL is malformed ({e}); falling back to in-memory cache");
                println!("Cache store: in-memory (Redis URL invalid)");
                cache::CacheStore::InMemory(cache::InMemoryStore::new())
            }
        },
        None => {
            println!("Cache store: in-memory (REDIS_URL not set)");
            cache::CacheStore::InMemory(cache::InMemoryStore::new())
        }
    };

    let metrics = Arc::new(metrics::Metrics::new());
    let rate_limiter = Arc::new(ratelimit::RateLimiter::new());
    let state = Arc::new(AppState {
        client: Arc::new(LastfmClient::with_keys(api_keys, key_store)),
        spotify,
        cache: cache_store,
        metrics: Arc::clone(&metrics),
        db,
        db_configured,
        redis_configured,
        lastfm_secret,
        rate_limiter: Arc::clone(&rate_limiter),
    });

    // Sweep idle rate-limit buckets every 10 minutes so the map can't grow
    // without bound under IP churn. Cheap; never touches a response.
    let rl_sweep = Arc::clone(&rate_limiter);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(600));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            rl_sweep.sweep();
        }
    });

    // Emit one structured metrics summary line every hour. Interval, not sleep,
    // so ticks don't drift. First (immediate) tick is consumed so the initial
    // all-zero line isn't logged; the shutdown path logs the final snapshot.
    let metrics_interval = Arc::clone(&metrics);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(3600));
        ticker.tick().await; // consume the immediate first tick
        loop {
            ticker.tick().await;
            println!("{}", metrics_interval.summary_line());
        }
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

    let app = build_router(Arc::clone(&state)).layer(cors);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Listening on {}", addr);
    // Graceful shutdown on Ctrl-C: emit the final metrics summary so the last
    // run's totals aren't lost between hourly ticks. Falls through immediately
    // if signal registration fails (still logs the snapshot).
    let metrics_shutdown = Arc::clone(&metrics);
    let shutdown = async move {
        let _ = tokio::signal::ctrl_c().await;
        println!("{}", metrics_shutdown.summary_line());
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .unwrap();
}

// ── Integration tests ───────────────────────────────────────────────────────
// Two tiers:
//   * No-DB router tests: exercise the real HTTP layer (oneshot) with
//     persistence OFF, asserting the pinned status codes (400/401/429/503) and
//     the /api/status 3-state shape. These run in every `cargo test`.
//   * Live-Postgres tests: gated on DATABASE_URL. They boot `Db::connect()`
//     against a real Postgres (docker on :5433 in CI) and drive auth session
//     lifecycle (mock Last.fm), events 204/410, dedup, observation batch dedup,
//     dismissal derived writes, and impressions. Skipped cleanly when unset.
#[cfg(test)]
mod integration_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn base_state(
        db: Option<Arc<db::Db>>,
        db_configured: bool,
        lastfm_secret: Option<String>,
        rate_limiter: Arc<ratelimit::RateLimiter>,
    ) -> Arc<AppState> {
        Arc::new(AppState {
            client: Arc::new(LastfmClient::with_keys(vec!["TESTKEY".to_string()], None)),
            spotify: None,
            cache: cache::CacheStore::InMemory(cache::InMemoryStore::new()),
            metrics: Arc::new(metrics::Metrics::new()),
            db,
            db_configured,
            redis_configured: false,
            lastfm_secret,
            rate_limiter,
        })
    }

    fn no_db_state() -> Arc<AppState> {
        base_state(None, false, None, Arc::new(ratelimit::RateLimiter::new()))
    }

    async fn status_of(app: Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn ev_req(body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/events")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "203.0.113.10")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    // ── No-DB router tests ──────────────────────────────────────────────────

    #[tokio::test]
    async fn status_reports_all_disabled_without_config() {
        let app = build_router(no_db_state());
        let (status, json) = status_of(
            app,
            Request::builder().uri("/api/status").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["postgres"], "disabled");
        assert_eq!(json["redis"], "disabled");
        assert_eq!(json["spotify"], "disabled");
        assert_eq!(json["lastfm_auth"], "disabled");
        assert_eq!(json["key_pool"]["keys"], 1);
        assert!(json["version"].is_string());
    }

    #[tokio::test]
    async fn events_malformed_body_is_400() {
        let app = build_router(no_db_state());
        let resp = app.oneshot(ev_req("{not json")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn events_unknown_type_is_400() {
        let app = build_router(no_db_state());
        let resp = app
            .oneshot(ev_req(r#"{"type":"frobnicate","rec_id":"11111111-1111-4111-8111-111111111111"}"#))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn events_oversized_body_is_400() {
        let app = build_router(no_db_state());
        let big = format!(r#"{{"type":"share","run_id":"11111111-1111-4111-8111-111111111111","dedup_key":"{}"}}"#, "x".repeat(3000));
        let resp = app.oneshot(ev_req(&big)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn events_save_without_bearer_is_401() {
        // save requires auth; anonymous → 401 (even before the DB gate).
        let app = build_router(no_db_state());
        let resp = app
            .oneshot(ev_req(r#"{"type":"save","rec_id":"11111111-1111-4111-8111-111111111111"}"#))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn events_valid_anonymous_without_db_is_503() {
        // A well-formed anonymous event with persistence off → 503 (never a
        // silent success — the frontend only sends when status says persistence).
        let app = build_router(no_db_state());
        let resp = app
            .oneshot(ev_req(r#"{"type":"share","run_id":"11111111-1111-4111-8111-111111111111"}"#))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn events_rate_limited_is_429_with_retry_after() {
        // Capacity-1 bucket: first request passes the limiter (then 503, no DB),
        // second is throttled → 429 + Retry-After.
        let rl = Arc::new(ratelimit::RateLimiter::with_params(1.0, 0.0));
        let state = base_state(None, false, None, rl);
        let app = build_router(Arc::clone(&state));
        let first = app
            .oneshot(ev_req(r#"{"type":"share","run_id":"11111111-1111-4111-8111-111111111111"}"#))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::SERVICE_UNAVAILABLE);
        let app2 = build_router(state);
        let second = app2
            .oneshot(ev_req(r#"{"type":"share","run_id":"11111111-1111-4111-8111-111111111111"}"#))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(second.headers().get(axum::http::header::RETRY_AFTER).is_some());
    }

    #[tokio::test]
    async fn auth_session_without_secret_is_503() {
        let app = build_router(no_db_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/session")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"token":"abc"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn me_saved_without_bearer_is_401() {
        let app = build_router(no_db_state());
        let resp = app
            .oneshot(Request::builder().uri("/api/me/saved").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn logout_without_bearer_is_204() {
        let app = build_router(no_db_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/auth/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    // ── Live-Postgres tests (gated on DATABASE_URL) ─────────────────────────

    fn have_db() -> bool {
        std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty()).is_some()
    }

    async fn connect_db_or_skip(name: &str) -> Option<Arc<db::Db>> {
        if !have_db() {
            eprintln!("DATABASE_URL unset — skipping {name}");
            return None;
        }
        match db::Db::connect().await {
            Some(db) => Some(Arc::new(db)),
            None => {
                eprintln!("DATABASE_URL set but connect failed — skipping {name}");
                None
            }
        }
    }

    fn rec_uuid() -> Uuid {
        Uuid::new_v4()
    }

    fn run_record(user_id: Option<Uuid>) -> db::RunRecord {
        db::RunRecord {
            run_id: Uuid::new_v4(),
            user_id,
            username: format!("u{}", Uuid::new_v4().simple()),
            period: "1month".into(),
            appetite: "balanced".into(),
            depth_score: 42.0,
            active_seed_count: 30,
            top_genres: serde_json::json!([]),
        }
    }

    #[tokio::test]
    async fn live_session_lifecycle() {
        let Some(db) = connect_db_or_skip("live_session_lifecycle").await else { return };
        let username = format!("user{}", Uuid::new_v4().simple());
        // upsert is idempotent → same id twice.
        let id1 = db.upsert_user(&username).await.unwrap();
        let id2 = db.upsert_user(&username).await.unwrap();
        assert_eq!(id1, id2, "normalized username upserts to the same synthetic id");

        let token = auth::mint_token();
        let expires = chrono::Utc::now() + chrono::Duration::days(auth::SESSION_TTL_DAYS);
        db.create_session(id1, &token.hash, expires).await.unwrap();
        // Lookup by hash resolves the user.
        let who = db.lookup_session(&token.hash).await.expect("session resolves");
        assert_eq!(who.user_id, id1);
        // Delete → gone.
        db.delete_session(&token.hash).await.unwrap();
        assert!(db.lookup_session(&token.hash).await.is_none(), "deleted session no longer resolves");

        // Expired sessions never resolve.
        let expired = auth::mint_token();
        let past = chrono::Utc::now() - chrono::Duration::days(1);
        db.create_session(id1, &expired.hash, past).await.unwrap();
        assert!(db.lookup_session(&expired.hash).await.is_none(), "expired session rejected");
    }

    #[tokio::test]
    async fn live_auth_session_handler_with_mock_lastfm() {
        let Some(db) = connect_db_or_skip("live_auth_session_handler").await else { return };

        // Spin a mock Last.fm returning a canned auth.getSession session.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mock = Router::new().route(
            "/",
            get(|| async {
                axum::Json(serde_json::json!({
                    "session": { "name": "MockUser", "key": "sk_123", "subscriber": 0 }
                }))
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        std::env::set_var("LASTFM_API_BASE", format!("http://{}/", addr));

        let state = base_state(Some(Arc::clone(&db)), true, Some("secret".into()), Arc::new(ratelimit::RateLimiter::new()));

        // POST /api/auth/session → 200 with a session token.
        let app = build_router(Arc::clone(&state));
        let (status, json) = status_of(
            app,
            Request::builder()
                .method("POST")
                .uri("/api/auth/session")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"token":"cb_token"}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["username"], "MockUser");
        let token = json["session_token"].as_str().unwrap().to_string();
        assert_eq!(token.len(), 64);

        // The token authorizes a personal read.
        let app = build_router(Arc::clone(&state));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/me/saved")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Logout revokes it.
        let app = build_router(Arc::clone(&state));
        let logout = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/auth/session")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::NO_CONTENT);

        let app = build_router(Arc::clone(&state));
        let after = app
            .oneshot(
                Request::builder()
                    .uri("/api/me/saved")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(after.status(), StatusCode::UNAUTHORIZED, "revoked token no longer authorizes");
        std::env::remove_var("LASTFM_API_BASE");
    }

    #[tokio::test]
    async fn live_events_204_and_410() {
        let Some(db) = connect_db_or_skip("live_events_204_and_410").await else { return };
        // Persist a fresh run + rec so a click has a valid, in-TTL target.
        let run = run_record(None);
        let run_id = run.run_id;
        let rec_id = rec_uuid();
        let recs = vec![db::RecRecord {
            rec_id,
            artist_name: "Fresh Artist".into(),
            artist_name_norm: utils::normalize_artist_name("Fresh Artist"),
            rank: 1,
            conviction_score: 100,
            composite_score: 1.0,
            total_listeners: 1234,
        }];
        db.test_persist_run(run, recs, vec![]).await.unwrap();

        let state = base_state(Some(Arc::clone(&db)), true, None, Arc::new(ratelimit::RateLimiter::new()));

        // 204 on a valid anonymous click_listen against the fresh rec.
        let app = build_router(Arc::clone(&state));
        let resp = app
            .oneshot(ev_req(&format!(
                r#"{{"type":"click_listen","rec_id":"{rec_id}","target":"lastfm"}}"#
            )))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // 410 on an unknown rec_id.
        let app = build_router(Arc::clone(&state));
        let unknown = rec_uuid();
        let resp = app
            .oneshot(ev_req(&format!(
                r#"{{"type":"click_listen","rec_id":"{unknown}","target":"lastfm"}}"#
            )))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::GONE);

        // 410 on an expired rec (created 25h ago).
        let old_run = run_record(None);
        let old_rec = rec_uuid();
        db.test_insert_backdated_rec(old_rec, old_run, "Old Artist", 25 * 3600)
            .await
            .unwrap();
        let app = build_router(Arc::clone(&state));
        let resp = app
            .oneshot(ev_req(&format!(
                r#"{{"type":"click_listen","rec_id":"{old_rec}","target":"lastfm"}}"#
            )))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::GONE, "expired rec → 410");

        let _ = run_id; // silence unused when assertions above suffice
    }

    #[tokio::test]
    async fn live_event_dedup_and_save_derived() {
        let Some(db) = connect_db_or_skip("live_event_dedup_and_save_derived").await else { return };
        let username = format!("user{}", Uuid::new_v4().simple());
        let user_id = db.upsert_user(&username).await.unwrap();
        let run = run_record(Some(user_id));
        let rec_id = rec_uuid();
        let recs = vec![db::RecRecord {
            rec_id,
            artist_name: "Saved Artist".into(),
            artist_name_norm: utils::normalize_artist_name("Saved Artist"),
            rank: 1,
            conviction_score: 50,
            composite_score: 2.0,
            total_listeners: 999,
        }];
        db.test_persist_run(run, recs, vec![]).await.unwrap();

        // Two identical save events with the same dedup_key → one events row.
        let mk = || db::EventRecord {
            id: Uuid::new_v4(),
            run_id: None,
            rec_id: Some(rec_id),
            user_id: Some(user_id),
            event_type: "save".into(),
            target: None,
            dedup_key: Some("dk-1".into()),
            derived: Some(db::Derived::Save {
                rec_id,
                artist_name: "Saved Artist".into(),
                artist_name_norm: utils::normalize_artist_name("Saved Artist"),
            }),
        };
        db.test_process_event(mk()).await.unwrap();
        db.test_process_event(mk()).await.unwrap();
        assert_eq!(db.test_count_events(rec_id, "save").await, 1, "dedup_key collapses to one event");

        // The save derived-write is reflected in /api/me/saved.
        let saved = db.saved_list(user_id).await.unwrap();
        let arr = saved["saved"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "Saved Artist");

        // dismiss derived-write lands in the dismissed set.
        db.test_process_event(db::EventRecord {
            id: Uuid::new_v4(),
            run_id: None,
            rec_id: Some(rec_id),
            user_id: Some(user_id),
            event_type: "dismiss".into(),
            target: None,
            dedup_key: None,
            derived: Some(db::Derived::Dismiss {
                rec_id,
                artist_name: "Saved Artist".into(),
                artist_name_norm: utils::normalize_artist_name("Saved Artist"),
            }),
        })
        .await
        .unwrap();
        let dismissed = db.dismissed_norms(user_id).await;
        assert!(dismissed.contains(&utils::normalize_artist_name("Saved Artist")));
    }

    #[tokio::test]
    async fn live_observation_batch_dedup() {
        let Some(db) = connect_db_or_skip("live_observation_batch_dedup").await else { return };
        let norm = format!("artist{}", Uuid::new_v4().simple());
        let obs = vec![
            db::ObsRecord { artist_name_norm: norm.clone(), mbid: None, listeners: 100 },
            db::ObsRecord { artist_name_norm: norm.clone(), mbid: None, listeners: 200 },
        ];
        // First run: two same-day observations for one artist → one row.
        db.test_persist_run(run_record(None), vec![], obs).await.unwrap();
        assert_eq!(db.test_count_observations(&norm).await, 1, "one row per artist/day within a run");

        // Second run same day → still one row (ON CONFLICT DO NOTHING).
        let obs2 = vec![db::ObsRecord { artist_name_norm: norm.clone(), mbid: None, listeners: 300 }];
        db.test_persist_run(run_record(None), vec![], obs2).await.unwrap();
        assert_eq!(db.test_count_observations(&norm).await, 1, "no new row for the same day across runs");
    }

    #[tokio::test]
    async fn live_impression_on_cache_hit() {
        let Some(db) = connect_db_or_skip("live_impression_on_cache_hit").await else { return };
        let run = run_record(None);
        let run_id = run.run_id;
        db.test_persist_run(run, vec![], vec![]).await.unwrap();
        db.enqueue_impression(run_id);
        db.test_drain().await;
        assert!(db.test_count_impressions(run_id).await >= 1, "cache-hit impression recorded");
    }
}
