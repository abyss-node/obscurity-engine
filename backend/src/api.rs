// Phase 1 HTTP surface: identity (auth session), first-party events, me/*,
// and status. Every new endpoint speaks the `{error, code}` envelope and the
// pinned status codes (400/401/410/429/204/503). Graceful fallback is enforced
// at the top of each handler: with no database the write/personal endpoints
// 503 or 401 rather than pretending to persist.

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth;
use crate::db::{self, AuthedUser, Derived, EventRecord, ObsRecord, RecRecord, RunRecord};
use crate::models::{DiscoveryResponse, DiscoveryResponseItem, ErrorResponse};
use crate::utils::normalize_artist_name;
use crate::AppState;

/// Max accepted body for `POST /api/events` (pinned contract: ≤2KB). Keeps a
/// beacon flood cheap to reject and bounds JSON parse cost.
const MAX_EVENT_BODY: usize = 2048;

/// The event types the contract accepts.
const ANONYMOUS_OK: &[&str] = &["click_listen", "share"];
const VALID_TARGETS: &[&str] = &["lastfm", "spotify", "bandcamp", "thisis"];

// ── envelope helpers ────────────────────────────────────────────────────────

fn envelope(code: StatusCode, msg: &str) -> Response {
    (
        code,
        Json(ErrorResponse { error: msg.to_string(), code: code.as_u16() }),
    )
        .into_response()
}

// ── client IP (for the rate limiter) ────────────────────────────────────────

/// Client IP key for rate limiting. Railway (and any standard reverse proxy)
/// sets `X-Forwarded-For`; we take the left-most hop. Absent → a single shared
/// "unknown" bucket, which still bounds a direct-to-origin flood.
pub fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

// ── auth resolution (request path) ──────────────────────────────────────────

/// Resolve the authenticated user from an `Authorization: Bearer <token>`
/// header. Returns `None` for anonymous requests WITHOUT touching the DB (the
/// bearer is checked first), and for invalid/expired sessions.
pub async fn resolve_auth(headers: &HeaderMap, db: &Option<Arc<db::Db>>) -> Option<AuthedUser> {
    let raw = auth::bearer_from_header(headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()))?;
    let db = db.as_ref()?;
    let hash = auth::hash_token(&raw);
    db.lookup_session(&hash).await
}

// ── POST /api/auth/session ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AuthSessionBody {
    token: String,
}

pub async fn auth_session_handler(
    State(state): State<Arc<AppState>>,
    body: Result<Json<AuthSessionBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(b) => b,
        Err(_) => return envelope(StatusCode::BAD_REQUEST, "malformed request body"),
    };
    // Signing secret is required to exchange the token. Without it the whole
    // login feature is off — the frontend hides the entry when status says so.
    let Some(secret) = state.lastfm_secret.as_ref() else {
        return envelope(StatusCode::SERVICE_UNAVAILABLE, "last.fm auth not configured");
    };
    // No database → nowhere to mint a session. Fail loud, not silent.
    let Some(db) = state.db.as_ref() else {
        return envelope(StatusCode::SERVICE_UNAVAILABLE, "persistence not configured");
    };
    if body.token.trim().is_empty() {
        return envelope(StatusCode::BAD_REQUEST, "missing token");
    }

    let session = match state.client.get_session(body.token.trim(), secret).await {
        Ok(s) => s,
        Err(e) if e.is_transient() => {
            eprintln!("auth.getSession transient failure: {e}");
            return envelope(StatusCode::SERVICE_UNAVAILABLE, "last.fm temporarily unavailable");
        }
        Err(e) => {
            eprintln!("auth.getSession rejected: {e}");
            return envelope(StatusCode::BAD_REQUEST, "invalid or expired token");
        }
    };

    let username_norm = session.username.trim().to_lowercase();
    let user_id = match db.upsert_user(&username_norm).await {
        Ok(id) => id,
        Err(e) => {
            eprintln!("auth: upsert_user failed: {e}");
            return envelope(StatusCode::SERVICE_UNAVAILABLE, "could not create session");
        }
    };
    let token = auth::mint_token();
    let expires = chrono::Utc::now() + chrono::Duration::days(auth::SESSION_TTL_DAYS);
    if let Err(e) = db.create_session(user_id, &token.hash, expires).await {
        eprintln!("auth: create_session failed: {e}");
        return envelope(StatusCode::SERVICE_UNAVAILABLE, "could not create session");
    }

    (
        StatusCode::OK,
        Json(json!({
            "session_token": token.raw,
            "username": session.username,
            "user_id": user_id.to_string(),
        })),
    )
        .into_response()
}

// ── DELETE /api/auth/session ────────────────────────────────────────────────

pub async fn auth_logout_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    // Idempotent: logging out an already-gone/absent session still 204s.
    if let Some(raw) = auth::bearer_from_header(
        headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
    ) {
        if let Some(db) = state.db.as_ref() {
            let _ = db.delete_session(&auth::hash_token(&raw)).await;
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

// ── POST /api/events ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EventBody {
    pub rec_id: Option<String>,
    pub run_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub target: Option<String>,
    pub dedup_key: Option<String>,
}

/// A shape-validated event (pre-DB). `requires_auth` = save/dismiss family.
pub struct ValidatedEvent {
    pub event_type: String,
    pub rec_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub target: Option<String>,
    pub dedup_key: Option<String>,
    pub requires_auth: bool,
}

/// Pure validation of an event body → 400 message on failure. Enforces the
/// type whitelist, "at least one id", per-type id/target requirements, and the
/// anonymous-allowed rule (which types MAY be sent without a session).
pub fn validate_event(body: &EventBody) -> Result<ValidatedEvent, String> {
    let ty = body.event_type.as_str();
    let known = matches!(
        ty,
        "click_listen" | "save" | "unsave" | "dismiss" | "undo_dismiss" | "share"
    );
    if !known {
        return Err(format!("unknown event type '{ty}'"));
    }

    let rec_id = match &body.rec_id {
        Some(s) if !s.is_empty() => {
            Some(Uuid::parse_str(s).map_err(|_| "rec_id is not a valid id".to_string())?)
        }
        _ => None,
    };
    let run_id = match &body.run_id {
        Some(s) if !s.is_empty() => {
            Some(Uuid::parse_str(s).map_err(|_| "run_id is not a valid id".to_string())?)
        }
        _ => None,
    };
    if rec_id.is_none() && run_id.is_none() {
        return Err("at least one of rec_id or run_id is required".to_string());
    }

    // Per-type requirements.
    match ty {
        "click_listen" => {
            if rec_id.is_none() {
                return Err("click_listen requires rec_id".to_string());
            }
            match body.target.as_deref() {
                Some(t) if VALID_TARGETS.contains(&t) => {}
                _ => return Err("click_listen requires a valid target".to_string()),
            }
        }
        "save" | "unsave" | "dismiss" | "undo_dismiss" => {
            if rec_id.is_none() {
                return Err(format!("{ty} requires rec_id"));
            }
        }
        _ => {} // share: at least one id (already enforced)
    }

    if let Some(k) = &body.dedup_key {
        if k.len() > 200 {
            return Err("dedup_key too long".to_string());
        }
    }
    if let Some(t) = &body.target {
        if t.len() > 40 {
            return Err("target too long".to_string());
        }
    }

    let requires_auth = !ANONYMOUS_OK.contains(&ty);
    Ok(ValidatedEvent {
        event_type: ty.to_string(),
        rec_id,
        run_id,
        target: body.target.clone(),
        dedup_key: body.dedup_key.clone(),
        requires_auth,
    })
}

pub async fn events_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // 1. Per-IP rate limit (cheap, before any parsing).
    let ip = client_ip(&headers);
    if let crate::ratelimit::Decision::Deny { retry_after_secs } = state.rate_limiter.check(&ip) {
        let mut resp = envelope(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
        if let Ok(v) = header::HeaderValue::from_str(&retry_after_secs.to_string()) {
            resp.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return resp;
    }
    // 2. Body size (contract: ≤2KB).
    if body.len() > MAX_EVENT_BODY {
        return envelope(StatusCode::BAD_REQUEST, "event body too large");
    }
    // 3. Parse + 4. validate shape.
    let parsed: EventBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return envelope(StatusCode::BAD_REQUEST, "malformed event body"),
    };
    let ve = match validate_event(&parsed) {
        Ok(v) => v,
        Err(msg) => return envelope(StatusCode::BAD_REQUEST, &msg),
    };

    // 5. Auth (save/dismiss family): reject anonymous with 401.
    let authed = resolve_auth(&headers, &state.db).await;
    if ve.requires_auth && authed.is_none() {
        return envelope(StatusCode::UNAUTHORIZED, "authentication required for this event");
    }

    // 6. Persistence must be configured to accept an event at all.
    let Some(db) = state.db.as_ref() else {
        return envelope(StatusCode::SERVICE_UNAVAILABLE, "persistence not configured");
    };

    // 7. Referenced rec/run must exist and (for rec) be within the TTL → else 410.
    let mut derived: Option<Derived> = None;
    if let Some(rec_id) = ve.rec_id {
        let Some(meta) = db.rec_meta_fresh(rec_id).await else {
            return envelope(StatusCode::GONE, "recommendation expired or unknown");
        };
        derived = match ve.event_type.as_str() {
            "save" => Some(Derived::Save {
                rec_id,
                artist_name: meta.artist_name.clone(),
                artist_name_norm: meta.artist_name_norm.clone(),
            }),
            "unsave" => Some(Derived::Unsave { artist_name_norm: meta.artist_name_norm.clone() }),
            "dismiss" => Some(Derived::Dismiss {
                rec_id,
                artist_name: meta.artist_name.clone(),
                artist_name_norm: meta.artist_name_norm.clone(),
            }),
            "undo_dismiss" => {
                Some(Derived::UndoDismiss { artist_name_norm: meta.artist_name_norm.clone() })
            }
            _ => None,
        };
    } else if let Some(run_id) = ve.run_id {
        // Run-scoped event (share): the run must exist.
        if !db.run_exists(run_id).await {
            return envelope(StatusCode::GONE, "run expired or unknown");
        }
    }

    // 8. Enqueue off-path and 204. The write (and any derived save/dismiss) is
    // durable-best-effort; the response never waits on it.
    db.enqueue_event(EventRecord {
        id: Uuid::new_v4(),
        run_id: ve.run_id,
        rec_id: ve.rec_id,
        user_id: authed.as_ref().map(|u| u.user_id),
        event_type: ve.event_type.clone(),
        target: ve.target.clone(),
        dedup_key: ve.dedup_key.clone(),
        derived,
    });
    state.metrics.record_event(&ve.event_type);
    StatusCode::NO_CONTENT.into_response()
}

// ── GET /api/me/saved, GET/DELETE /api/me/data ──────────────────────────────

pub async fn me_saved_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(user) = resolve_auth(&headers, &state.db).await else {
        return envelope(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let db = state.db.as_ref().unwrap(); // resolve_auth succeeded ⇒ db present
    match db.saved_list(user.user_id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => {
            eprintln!("me/saved failed: {e}");
            envelope(StatusCode::SERVICE_UNAVAILABLE, "could not read saved artists")
        }
    }
}

pub async fn me_data_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(user) = resolve_auth(&headers, &state.db).await else {
        return envelope(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let db = state.db.as_ref().unwrap();
    match db.export_data(&user).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => {
            eprintln!("me/data export failed: {e}");
            envelope(StatusCode::SERVICE_UNAVAILABLE, "could not export data")
        }
    }
}

pub async fn me_data_delete_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(user) = resolve_auth(&headers, &state.db).await else {
        return envelope(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let db = state.db.as_ref().unwrap();
    match db.purge_user(user.user_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            eprintln!("me/data delete failed: {e}");
            envelope(StatusCode::SERVICE_UNAVAILABLE, "could not delete data")
        }
    }
}

// ── GET /api/status ─────────────────────────────────────────────────────────

pub async fn status_handler(State(state): State<Arc<AppState>>) -> Response {
    // postgres: disabled (unset) / ok (reachable) / error (set-but-unreachable).
    let postgres = if !state.db_configured {
        "disabled"
    } else {
        match state.db.as_ref() {
            Some(db) if db.ping().await => "ok",
            _ => "error",
        }
    };
    // redis: disabled / ok / error.
    let redis = if !state.redis_configured {
        "disabled"
    } else {
        match state.cache.redis_status().await {
            Some(true) => "ok",
            _ => "error",
        }
    };
    let spotify = if state.spotify.is_some() { "ok" } else { "disabled" };
    let lastfm_auth = if state.lastfm_secret.is_some() { "ok" } else { "disabled" };
    // listenbrainz: disabled (source=lastfm) / ok (blend arm live) / error (blend
    // arm selected but LB currently failing). Reflects the client health flag,
    // which is set by real discovery calls — no LB request is made from here.
    let listenbrainz = if !state.candidate_source.uses_listenbrainz() {
        "disabled"
    } else {
        match &state.listenbrainz {
            Some(lb) if lb.healthy() => "ok",
            _ => "error",
        }
    };

    (
        StatusCode::OK,
        Json(json!({
            "postgres": postgres,
            "redis": redis,
            "spotify": spotify,
            "lastfm_auth": lastfm_auth,
            "listenbrainz": listenbrainz,
            "key_pool": { "keys": state.client.key_count() },
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
        .into_response()
}

// ── Persistence preparation (assign ids, build write records) ───────────────

/// Assign a `run_id` and a per-item UUIDv4 `rec_id` to every response AND
/// reserve item (so a backfilled reserve item still has a valid rec_id), set the
/// response's `run_id`/`persistence` fields, and build the write records for the
/// off-path writer. Observations are taken from the getinfo listener counts
/// already in hand — ZERO added Last.fm calls. Ranks are 1-based across the
/// response then the reserve.
pub fn prepare_persistence(
    run_id: Uuid,
    user_id: Option<Uuid>,
    username: &str,
    period: &str,
    appetite: &str,
    response: &mut DiscoveryResponse,
    reserve: &mut [DiscoveryResponseItem],
) -> (RunRecord, Vec<RecRecord>, Vec<ObsRecord>) {
    let mut recs = Vec::new();
    let mut obs = Vec::new();
    let mut rank: i32 = 1;
    for item in response.artists.iter_mut().chain(reserve.iter_mut()) {
        let rec_id = Uuid::new_v4();
        item.rec_id = Some(rec_id.to_string());
        let norm = normalize_artist_name(&item.name);
        let listeners = item.total_listeners as i64;
        recs.push(RecRecord {
            rec_id,
            artist_name: item.name.clone(),
            artist_name_norm: norm.clone(),
            rank,
            conviction_score: item.conviction_score as i32,
            composite_score: item.composite_score,
            total_listeners: listeners,
        });
        obs.push(ObsRecord { artist_name_norm: norm, mbid: None, listeners });
        rank += 1;
    }
    response.run_id = Some(run_id.to_string());
    response.persistence = true;

    let run = RunRecord {
        run_id,
        user_id,
        username: username.to_string(),
        period: period.to_string(),
        appetite: appetite.to_string(),
        depth_score: response.depth_score,
        active_seed_count: response.active_seed_count as i32,
        top_genres: serde_json::to_value(&response.top_genres).unwrap_or_else(|_| json!([])),
    };
    (run, recs, obs)
}

// ── Dismissal filter (pure, post-pipeline) ──────────────────────────────────

/// Remove dismissed artists from the visible list and backfill from the reserve
/// (also skipping dismissed) so the response carries the same count it would
/// have without dismissals (cap 25 preserved). Zero scoring-math involvement —
/// this is an output filter over an already-ranked list.
pub fn apply_dismissals(
    mut response: DiscoveryResponse,
    reserve: Vec<DiscoveryResponseItem>,
    dismissed: &HashSet<String>,
) -> DiscoveryResponse {
    if dismissed.is_empty() {
        return response;
    }
    let target = response.artists.len();
    // Drop dismissed from the visible set.
    response
        .artists
        .retain(|a| !dismissed.contains(&normalize_artist_name(&a.name)));
    // Backfill from the reserve (skipping dismissed) up to the original count.
    for item in reserve.into_iter() {
        if response.artists.len() >= target {
            break;
        }
        if dismissed.contains(&normalize_artist_name(&item.name)) {
            continue;
        }
        response.artists.push(item);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DiscoveryResponse, DiscoveryResponseItem};

    fn eb(ty: &str, rec: Option<&str>, run: Option<&str>, target: Option<&str>) -> EventBody {
        EventBody {
            rec_id: rec.map(|s| s.to_string()),
            run_id: run.map(|s| s.to_string()),
            event_type: ty.to_string(),
            target: target.map(|s| s.to_string()),
            dedup_key: None,
        }
    }

    const UUID_A: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn validate_rejects_unknown_type() {
        assert!(validate_event(&eb("frobnicate", Some(UUID_A), None, None)).is_err());
    }

    #[test]
    fn validate_requires_at_least_one_id() {
        assert!(validate_event(&eb("share", None, None, None)).is_err());
    }

    #[test]
    fn validate_rejects_bad_uuid() {
        assert!(validate_event(&eb("share", Some("not-a-uuid"), None, None)).is_err());
    }

    #[test]
    fn validate_click_listen_needs_target_and_rec() {
        assert!(validate_event(&eb("click_listen", Some(UUID_A), None, None)).is_err(), "no target");
        assert!(validate_event(&eb("click_listen", Some(UUID_A), None, Some("myspace"))).is_err(), "bad target");
        assert!(validate_event(&eb("click_listen", None, Some(UUID_A), Some("spotify"))).is_err(), "needs rec_id");
        assert!(validate_event(&eb("click_listen", Some(UUID_A), None, Some("spotify"))).is_ok());
    }

    #[test]
    fn validate_click_listen_accepts_bandcamp_target() {
        // The frontend's "Support on Bandcamp" search-link (ArtistCard.tsx)
        // fires click_listen with target=bandcamp; must not 400.
        assert!(validate_event(&eb("click_listen", Some(UUID_A), None, Some("bandcamp"))).is_ok());
    }

    #[test]
    fn validate_anonymous_rules() {
        // save/dismiss/unsave/undo_dismiss require auth; click_listen/share do not.
        assert!(validate_event(&eb("save", Some(UUID_A), None, None)).unwrap().requires_auth);
        assert!(validate_event(&eb("unsave", Some(UUID_A), None, None)).unwrap().requires_auth);
        assert!(validate_event(&eb("dismiss", Some(UUID_A), None, None)).unwrap().requires_auth);
        assert!(validate_event(&eb("undo_dismiss", Some(UUID_A), None, None)).unwrap().requires_auth);
        assert!(!validate_event(&eb("share", None, Some(UUID_A), None)).unwrap().requires_auth);
        assert!(!validate_event(&eb("click_listen", Some(UUID_A), None, Some("lastfm"))).unwrap().requires_auth);
    }

    #[test]
    fn validate_save_needs_rec_id() {
        assert!(validate_event(&eb("save", None, Some(UUID_A), None)).is_err());
        assert!(validate_event(&eb("save", Some(UUID_A), None, None)).is_ok());
    }

    #[test]
    fn client_ip_prefers_forwarded_for() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&h), "203.0.113.7");
        let empty = HeaderMap::new();
        assert_eq!(client_ip(&empty), "unknown");
    }

    // ── dismissal filter ────────────────────────────────────────────────────

    fn item(name: &str) -> DiscoveryResponseItem {
        DiscoveryResponseItem {
            name: name.to_string(),
            stickiness_score: 0.0,
            conviction_score: 0,
            composite_score: 0.0,
            total_listeners: 0,
            top_tags: vec![],
            source_seeds: vec![],
            cross_validated: false,
            taste_alignment: 0.0,
            velocity: None,
            user_playcount: 0,
            reengagement: false,
            spotify_url: None,
            bandcamp_url: None,
            this_is_url: None,
            rec_id: None,
        }
    }

    fn resp(names: &[&str]) -> DiscoveryResponse {
        DiscoveryResponse {
            artists: names.iter().map(|n| item(n)).collect(),
            top_genres: vec![],
            deepest_date: None,
            active_seed_count: 0,
            depth_score: 0.0,
            message: None,
            run_id: None,
            persistence: false,
        }
    }

    #[test]
    fn dismissal_filters_and_backfills_to_preserve_count() {
        let response = resp(&["A", "B", "C"]);
        let reserve = vec![item("D"), item("E")];
        let mut dismissed = HashSet::new();
        dismissed.insert(normalize_artist_name("B"));
        let out = apply_dismissals(response, reserve, &dismissed);
        let names: Vec<_> = out.artists.iter().map(|a| a.name.as_str()).collect();
        // B removed, D backfilled from reserve; count preserved at 3.
        assert_eq!(names, vec!["A", "C", "D"]);
    }

    #[test]
    fn dismissal_skips_dismissed_reserve_items() {
        let response = resp(&["A", "B"]);
        // Reserve's first item is also dismissed → skipped; next one used.
        let reserve = vec![item("D"), item("E")];
        let mut dismissed = HashSet::new();
        dismissed.insert(normalize_artist_name("A"));
        dismissed.insert(normalize_artist_name("D"));
        let out = apply_dismissals(response, reserve, &dismissed);
        let names: Vec<_> = out.artists.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["B", "E"]);
    }

    #[test]
    fn prepare_persistence_uses_only_in_hand_data() {
        // `prepare_persistence` takes NO Last.fm client — observations are built
        // from the getinfo listener counts already carried on each item, so it
        // adds ZERO Last.fm calls (guaranteed by its signature). This asserts the
        // mapping: obs come from item.total_listeners; rec_ids get assigned; the
        // run row reflects the response.
        let mut response = resp(&["A", "B"]);
        response.artists[0].total_listeners = 111;
        response.artists[1].total_listeners = 222;
        response.depth_score = 55.0;
        response.active_seed_count = 30;
        let mut reserve = vec![item("C")];
        reserve[0].total_listeners = 333;

        let run_id = Uuid::new_v4();
        let (run, recs, obs) = prepare_persistence(
            run_id, None, "someuser", "1month", "balanced", &mut response, &mut reserve,
        );

        // rec_ids assigned to visible + reserve items.
        assert!(response.artists.iter().all(|a| a.rec_id.is_some()));
        assert!(reserve.iter().all(|a| a.rec_id.is_some()));
        assert_eq!(response.run_id, Some(run_id.to_string()));
        assert!(response.persistence);

        // One rec + one observation per item (visible + reserve = 3).
        assert_eq!(recs.len(), 3);
        assert_eq!(obs.len(), 3);
        // Observation listeners mirror the items exactly (no fetch).
        let mut ls: Vec<i64> = obs.iter().map(|o| o.listeners).collect();
        ls.sort();
        assert_eq!(ls, vec![111, 222, 333]);
        assert!(obs.iter().all(|o| o.mbid.is_none()));
        assert_eq!(run.depth_score, 55.0);
        assert_eq!(run.active_seed_count, 30);
        assert_eq!(run.username, "someuser");
    }

    #[test]
    fn dismissal_noop_when_empty_set() {
        let response = resp(&["A", "B", "C"]);
        let out = apply_dismissals(response, vec![item("D")], &HashSet::new());
        assert_eq!(out.artists.len(), 3, "no reserve pulled in when nothing dismissed");
    }

    #[test]
    fn dismissal_shrinks_when_reserve_exhausted() {
        let response = resp(&["A", "B"]);
        let mut dismissed = HashSet::new();
        dismissed.insert(normalize_artist_name("A"));
        let out = apply_dismissals(response, vec![], &dismissed);
        assert_eq!(out.artists.len(), 1, "no backfill available → returns fewer");
    }
}
