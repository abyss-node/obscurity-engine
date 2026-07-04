// obscurity-engine backend — Axum HTTP server (deployed to Railway).
//
// This file owns only: AppState construction, router assembly, CORS, and
// boot/shutdown. HTTP handlers live in `api.rs` (Phase 1 identity/events/
// me/status) and `handlers.rs` (discovery, tracks, spotify-track, keys).
use axum::{
    routing::{get, post},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use std::sync::Arc;
use std::time::Duration;

mod api;
mod auth;
mod cache;
mod db;
mod handlers;
mod lastfm;
mod listenbrainz;
mod metrics;
mod models;
mod pipeline;
mod ratelimit;
mod spotify;
mod utils;

use lastfm::LastfmClient;
use listenbrainz::{CandidateSource, ListenBrainzClient};
use spotify::SpotifyClient;

pub struct AppState {
    pub client: Arc<LastfmClient>,
    pub spotify: Option<Arc<SpotifyClient>>,
    // Candidate-generation source (CANDIDATE_SOURCE env). Default `Lastfm` —
    // exactly today's behavior. The lever is flipped in prod only after review.
    pub candidate_source: CandidateSource,
    // ListenBrainz client, wired only when `candidate_source` needs it. `None`
    // for the default `lastfm` source (the blend arm is never constructed).
    pub listenbrainz: Option<Arc<ListenBrainzClient>>,
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

/// Build the application router (all routes wired to `AppState`). Extracted so
/// integration tests can construct the exact same app; `main` layers CORS on top.
pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(|| async { "ObscurityEngine Backend Alive!" }))
        .route("/api/discovery", get(handlers::discovery_handler))
        .route("/api/discovery/tracks", get(handlers::track_discovery_handler))
        .route("/api/spotify/track", get(handlers::spotify_track_handler))
        .route("/api/keys", post(handlers::contribute_key_handler))
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

    // Candidate source: default `lastfm` (byte-identical to today). Only build
    // the ListenBrainz client when the lever actually selects it, so the default
    // path never constructs the blend arm.
    let candidate_source = CandidateSource::from_env();
    let listenbrainz = if candidate_source.uses_listenbrainz() {
        println!(
            "Candidate source: {} (ListenBrainz blend arm enabled, fail-open, 7-day cache)",
            candidate_source.as_str()
        );
        Some(Arc::new(ListenBrainzClient::new()))
    } else {
        println!("Candidate source: lastfm (default — ListenBrainz not used)");
        None
    };

    let metrics = Arc::new(metrics::Metrics::new());
    let rate_limiter = Arc::new(ratelimit::RateLimiter::new());
    let state = Arc::new(AppState {
        client: Arc::new(LastfmClient::with_keys(api_keys, key_store)),
        spotify,
        candidate_source,
        listenbrainz,
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
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use uuid::Uuid;

    fn base_state(
        db: Option<Arc<db::Db>>,
        db_configured: bool,
        lastfm_secret: Option<String>,
        rate_limiter: Arc<ratelimit::RateLimiter>,
    ) -> Arc<AppState> {
        Arc::new(AppState {
            client: Arc::new(LastfmClient::with_keys(vec!["TESTKEY".to_string()], None)),
            spotify: None,
            candidate_source: CandidateSource::Lastfm,
            listenbrainz: None,
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

    /// A no-DB state with the ListenBrainz blend arm wired (candidate source
    /// `blend`), optionally forced unhealthy — for the `/api/status` LB states.
    fn blend_state(healthy: bool) -> Arc<AppState> {
        let lb = ListenBrainzClient::new();
        if !healthy {
            lb.mark_unhealthy();
        }
        Arc::new(AppState {
            client: Arc::new(LastfmClient::with_keys(vec!["TESTKEY".to_string()], None)),
            spotify: None,
            candidate_source: CandidateSource::Blend,
            listenbrainz: Some(Arc::new(lb)),
            cache: cache::CacheStore::InMemory(cache::InMemoryStore::new()),
            metrics: Arc::new(metrics::Metrics::new()),
            db: None,
            db_configured: false,
            redis_configured: false,
            lastfm_secret: None,
            rate_limiter: Arc::new(ratelimit::RateLimiter::new()),
        })
    }

    #[tokio::test]
    async fn status_listenbrainz_ok_when_blend_healthy() {
        let (status, json) = status_of(
            build_router(blend_state(true)),
            Request::builder().uri("/api/status").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["listenbrainz"], "ok");
    }

    #[tokio::test]
    async fn status_listenbrainz_error_when_blend_unhealthy() {
        let (_status, json) = status_of(
            build_router(blend_state(false)),
            Request::builder().uri("/api/status").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(json["listenbrainz"], "error");
    }

    async fn status_of(app: Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// LASTFM_API_BASE is process-global, so tests that point it at a mock
    /// server must not run concurrently — one test's remove_var while another's
    /// request is in flight sends that request to the real Last.fm URL. The
    /// guard serializes those tests and removes the var on drop, so a panicking
    /// assertion can't leak the override into later tests either.
    static LASTFM_API_BASE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct MockLastfmBase(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

    impl MockLastfmBase {
        fn set(addr: std::net::SocketAddr) -> Self {
            let guard = LASTFM_API_BASE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("LASTFM_API_BASE", format!("http://{}/", addr));
            MockLastfmBase(guard)
        }
    }

    impl Drop for MockLastfmBase {
        fn drop(&mut self) {
            std::env::remove_var("LASTFM_API_BASE");
        }
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
        // Default candidate source is lastfm → LB reports "disabled".
        assert_eq!(json["listenbrainz"], "disabled");
        assert_eq!(json["key_pool"]["keys"], 1);
        assert!(json["version"].is_string());
    }

    #[tokio::test]
    async fn discovery_nonexistent_user_is_404_not_generic_500() {
        // Last.fm error code 6 on user.gettopartists means "user not found" — a
        // permanent, user-facing failure. Before the F3 fix, seeds.rs stringified
        // every fetch_user_top_artists error into "Failed to fetch top artists:
        // ...", which handlers.rs then always mapped to a 500 "Discovery failed:
        // ..." — and the frontend's busy/rate-limit heuristic matched that wording
        // and told the user Last.fm was rate-limiting them. Lock in the real fix:
        // a nonexistent username now surfaces as 404 with unambiguous wording.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Real Last.fm serves error 6 WITH an HTTP 404 status (verified in prod
        // 2026-07-04) — the tracks test below keeps the legacy 200-with-error-body
        // shape so both transport shapes stay covered.
        let mock = Router::new().route(
            "/",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({ "error": 6, "message": "User not found" })),
                )
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        let _base = MockLastfmBase::set(addr);

        let app = build_router(no_db_state());
        let (status, json) = status_of(
            app,
            Request::builder()
                .uri("/api/discovery?username=nosuchuser&period=7day")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        let msg = json["error"].as_str().unwrap_or("").to_lowercase();
        assert!(!msg.contains("rate"), "must not read as a rate-limit failure: {msg}");
        assert!(!msg.contains("failed to fetch"), "must not carry the generic wrapper text: {msg}");
        assert!(msg.contains("not found"), "should clearly say the user wasn't found: {msg}");
    }

    #[tokio::test]
    async fn tracks_discovery_nonexistent_user_is_404_not_generic_500() {
        // Mirrors discovery_nonexistent_user_is_404_not_generic_500 above, for
        // the tracks endpoint: before the fast-follow fix, track_seeds.rs
        // stringified every fetch_user_top_tracks error into "Failed to fetch
        // top tracks: ...", which handlers.rs then always mapped to a 500
        // "Track discovery failed: ..." — the frontend's busy/rate-limit
        // heuristic matched that wording and told the user Last.fm was
        // rate-limiting them. Lock in the fix: a nonexistent username on
        // /api/discovery/tracks now surfaces as 404 with unambiguous wording.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mock = Router::new().route(
            "/",
            get(|| async {
                axum::Json(serde_json::json!({ "error": 6, "message": "User not found" }))
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        let _base = MockLastfmBase::set(addr);

        let app = build_router(no_db_state());
        let (status, json) = status_of(
            app,
            Request::builder()
                .uri("/api/discovery/tracks?username=nosuchuser&period=7day")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        let msg = json["error"].as_str().unwrap_or("").to_lowercase();
        assert!(!msg.contains("rate"), "must not read as a rate-limit failure: {msg}");
        assert!(!msg.contains("failed to fetch"), "must not carry the generic wrapper text: {msg}");
        assert!(msg.contains("not found"), "should clearly say the user wasn't found: {msg}");
    }

    #[tokio::test]
    async fn artist_info_fetch_requests_autocorrect_and_returns_canonical() {
        // LB-sourced candidates carry MB-canonical spellings ("Guns N’ Roses",
        // curly apostrophe); without autocorrect=1 Last.fm serves its separate
        // variant page — tiny listeners (defeats the 25K ceiling) and zero
        // userplaycount (defeats the played-before exclusion). Live prod bug
        // 2026-07-04. Lock in: getinfo always requests autocorrect.
        let captured: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(vec![]));
        let cap = Arc::clone(&captured);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mock = Router::new().route(
            "/",
            get(move |axum::extract::RawQuery(q): axum::extract::RawQuery| {
                let cap = Arc::clone(&cap);
                async move {
                    cap.lock().unwrap().push(q.unwrap_or_default());
                    axum::Json(serde_json::json!({
                        "artist": {
                            "name": "Guns N' Roses",
                            "stats": {
                                "listeners": "5291432",
                                "playcount": "263000000",
                                "userplaycount": "488"
                            },
                            "tags": { "tag": [{ "name": "hard rock" }] }
                        }
                    }))
                }
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        let _base = MockLastfmBase::set(addr);

        let client = crate::lastfm::LastfmClient::new("k".into());
        let info = client
            .fetch_artist_info("Guns N’ Roses", "someuser")
            .await
            .expect("artist info fetch should succeed against the mock");
        // Autocorrect resolves the variant spelling to the canonical page.
        assert_eq!(info.artist.name, "Guns N' Roses");
        assert_eq!(info.artist.stats.listeners, 5_291_432);
        let qs = captured.lock().unwrap().join("&");
        assert!(
            qs.contains("autocorrect=1"),
            "artist.getinfo must request autocorrect=1, got: {qs}"
        );
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
        let _base = MockLastfmBase::set(addr);

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
