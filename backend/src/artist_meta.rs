//! Artist origin metadata (country, area, begin year, type) from MusicBrainz.
//!
//! Design: `docs/design-artist-geo-2026-10-16.md`. The endpoint never waits on
//! MusicBrainz. It answers from storage immediately, and unresolved names go to
//! one background worker that resolves them serially and stores the result for
//! the client's next poll.
//!
//! ## Wire format
//! `GET /api/artist-meta?name=A&name=B` (repeated `name=` params, max 25, each
//! URL-decoded with `+` as space). Repeated params rather than `names=a,b,c`
//! because artist names contain commas ("Crosby, Stills & Nash").
//!
//! ## Sharing MusicBrainz with the blend arm
//! Every MB call goes through `ListenBrainzClient::mb_get_low_priority`, which
//! uses the blend arm's own `mb_sem` + `mb_pacer`, so the 1 req/s budget is
//! global. It yields to blend lookups (see that method): the semaphore is only
//! taken while no blend lookup is queued.
//!
//! ## Storage and failure semantics
//! Postgres `artist_meta` when `DATABASE_URL` is set (a DB error falls back to
//! the `CacheStore`), else the `CacheStore` with a 30-day TTL. Definitive
//! answers are stored, including misses (all-null row, retried after 30 days).
//! Transient failures (MB 5xx/503, transport, starvation by blend traffic) are
//! never stored, so they are retried on the next poll.
//!
//! ## Runtime hygiene
//! The in-flight set is a `std::sync::Mutex<HashSet>` that is never held across
//! an await. The worker is one task fed by a bounded channel (256); a full
//! queue drops the name (it stays in `pending` and is re-offered next poll).
//! The receiver is shared, and every request checks the worker's `JoinHandle`
//! and respawns it if it has exited, so a panic cannot silence the feature.
//! In-flight claims are released by a drop guard, so a panic or cancel cannot
//! leave a name pending forever.
//!
//! ## Flood bounds
//! Per-IP token bucket keyed on the left-most `X-Forwarded-For` hop (the same
//! `client_ip` as `/api/events`; client-supplied, but Render sets XFF itself)
//! on the endpoint, 60-token burst refilling at 0.5/s. Resolutions are
//! serial at about 1 per second, so entries enter the no-DB in-memory store at
//! no more than that rate regardless of how many junk names are requested;
//! they expire after 30 days.

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::listenbrainz::{ListenBrainzClient, MbError, MB_SCORE_FLOOR};
use crate::ratelimit::{Decision, RateLimiter};
use crate::models::{ArtistMetaEntry, ArtistMetaResponse, ErrorResponse};
use crate::utils::normalize_artist_name;
use crate::AppState;

pub const MAX_NAMES: usize = 25;
const MAX_NAME_LEN: usize = 200;
const QUEUE_CAP: usize = 256;
/// How long one lookup waits for blend traffic to clear before giving up.
const STARVE_BUDGET: Duration = Duration::from_secs(60);
/// A stored miss is retried after this long; a cache entry lives this long.
pub const MISS_RETRY: Duration = Duration::from_secs(30 * 24 * 3600);

/// Normalized storage key for a display name. Falls back to the lowercased
/// trimmed name when normalization strips everything (e.g. "!!!").
pub fn name_key(name: &str) -> String {
    let k = normalize_artist_name(name);
    if k.is_empty() {
        name.trim().to_lowercase()
    } else {
        k
    }
}

/// One stored row (DB or cache).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stored {
    pub mbid: Option<String>,
    pub entry: ArtistMetaEntry,
    pub fetched_at: DateTime<Utc>,
}

impl Stored {
    /// A miss row that is old enough to be looked up again.
    pub fn is_stale_miss(&self, now: DateTime<Utc>) -> bool {
        self.entry.is_empty()
            && now
                .signed_duration_since(self.fetched_at)
                .to_std()
                .map_or(false, |d| d >= MISS_RETRY)
    }
}

/// Result of one MusicBrainz resolution.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    Found { mbid: String, entry: ArtistMetaEntry },
    /// Definitive: no MB entry matched. Stored as an all-null row.
    Miss,
    /// Do not store; retry on a later poll.
    Transient,
}

// ── MB JSON parsing (pure) ──────────────────────────────────────────────────

/// Extract origin facts from an MB artist object. The same shape appears in a
/// lookup response and in a search hit.
pub fn parse_mb_artist(v: &Value) -> ArtistMetaEntry {
    let s = |x: Option<&Value>| {
        x.and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(str::to_string)
    };
    // `country` is absent for some artists whose area still carries an ISO
    // code; use it rather than reporting nothing.
    let country = s(v.get("country")).or_else(|| {
        s(v.get("area").and_then(|a| a.get("iso-3166-1-codes")).and_then(|c| c.get(0)))
    });
    let begin_year = v
        .get("life-span")
        .and_then(|l| l.get("begin"))
        .and_then(|b| b.as_str())
        .and_then(|b| b.get(..4))
        .and_then(|y| y.parse::<i32>().ok());
    ArtistMetaEntry {
        country_iso2: country,
        area_name: s(v.get("area").and_then(|a| a.get("name"))),
        begin_year,
        artist_type: s(v.get("type")),
    }
}

/// Lucene phrase query for a search by name (quotes/backslashes escaped).
fn search_query(name: &str) -> String {
    let esc = name.replace('\\', "\\\\").replace('"', "\\\"");
    format!("artist:\"{esc}\"")
}

// ── service ─────────────────────────────────────────────────────────────────

pub struct ArtistMetaService {
    lb: Arc<ListenBrainzClient>,
    /// Tier-1 mbid source (Last.fm getinfo). Off only in tests, where Last.fm
    /// has no mock hook.
    lastfm_tier: bool,
    mb_ok: AtomicBool,
    in_flight: Mutex<HashSet<String>>,
    tx: mpsc::Sender<String>,
    rx: Arc<tokio::sync::Mutex<mpsc::Receiver<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    limiter: RateLimiter,
}

/// Releases an in-flight claim when dropped (normal end, panic, or abort).
struct ClaimGuard<'a>(&'a ArtistMetaService, String);

impl Drop for ClaimGuard<'_> {
    fn drop(&mut self) {
        self.0.release(&self.1);
    }
}

type Row = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<String>,
    DateTime<Utc>,
);

impl ArtistMetaService {
    pub fn new(lb: Arc<ListenBrainzClient>) -> Self {
        Self::build(lb, true)
    }

    pub fn build(lb: Arc<ListenBrainzClient>, lastfm_tier: bool) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE_CAP);
        Self {
            lb,
            lastfm_tier,
            mb_ok: AtomicBool::new(true),
            in_flight: Mutex::new(HashSet::new()),
            tx,
            rx: Arc::new(tokio::sync::Mutex::new(rx)),
            worker: Mutex::new(None),
            limiter: RateLimiter::with_params(60.0, 0.5),
        }
    }

    /// For `/api/status`. False after the last MB call failed transiently.
    pub fn mb_ok(&self) -> bool {
        self.mb_ok.load(Ordering::Relaxed)
    }

    fn note(&self, e: Option<MbError>) {
        match e {
            None => self.mb_ok.store(true, Ordering::Relaxed),
            // Starved means blend traffic (or a stuck counter) kept lookups out
            // for the whole budget: surface it rather than reporting ok.
            Some(MbError::Transient) | Some(MbError::Starved) => {
                self.mb_ok.store(false, Ordering::Relaxed)
            }
            Some(MbError::NotFound) => {}
        }
    }

    /// Resolve one name against MusicBrainz. `tier1_mbid` is Last.fm's mbid.
    pub async fn resolve(&self, name: &str, tier1_mbid: Option<String>) -> Outcome {
        let base = self.lb.mb_base_url().to_string();
        if let Some(mbid) = tier1_mbid.filter(|m| !m.is_empty()) {
            let url = format!("{base}{mbid}");
            let r = self.lb.mb_get_low_priority(&url, &[("fmt", "json")], STARVE_BUDGET).await;
            self.note(r.as_ref().err().copied());
            match r {
                Ok(v) => return Outcome::Found { mbid, entry: parse_mb_artist(&v) },
                Err(MbError::NotFound) => {} // stale mbid on Last.fm: try search
                Err(_) => return Outcome::Transient,
            }
        }
        let q = search_query(name);
        let r = self
            .lb
            .mb_get_low_priority(
                &base,
                &[("query", q.as_str()), ("fmt", "json"), ("limit", "3")],
                STARVE_BUDGET,
            )
            .await;
        self.note(r.as_ref().err().copied());
        let v = match r {
            Ok(v) => v,
            Err(MbError::NotFound) => return Outcome::Miss,
            Err(_) => return Outcome::Transient,
        };
        let best = v.get("artists").and_then(|a| a.get(0));
        let score = best
            .and_then(|b| b.get("score"))
            .and_then(|s| s.as_i64().or_else(|| s.as_str().and_then(|x| x.parse().ok())))
            .unwrap_or(0);
        match best {
            Some(b) if score >= MB_SCORE_FLOOR => match b.get("id").and_then(|i| i.as_str()) {
                Some(id) => Outcome::Found { mbid: id.to_string(), entry: parse_mb_artist(b) },
                None => Outcome::Miss,
            },
            _ => Outcome::Miss,
        }
    }

    /// Reserve `key` for resolution. False when already in flight.
    fn claim(&self, key: &str) -> bool {
        self.in_flight.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string())
    }

    fn release(&self, key: &str) {
        self.in_flight.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }
}

// ── storage ─────────────────────────────────────────────────────────────────

fn cache_key(key: &str) -> String {
    format!("artist_meta:{key}")
}

async fn read_stored(state: &AppState, keys: &[String]) -> BTreeMap<String, Stored> {
    let mut out = BTreeMap::new();
    if let Some(db) = &state.db {
        let rows: Result<Vec<Row>, _> = sqlx::query_as(
            "SELECT name_key, mbid, country_iso2, area_name, begin_year, artist_type, fetched_at \
             FROM artist_meta WHERE name_key = ANY($1)",
        )
        .bind(keys)
        .fetch_all(db.pool())
        .await;
        match rows {
            Ok(rows) => {
                for (k, mbid, c, a, y, t, at) in rows {
                    out.insert(
                        k,
                        Stored {
                            mbid,
                            entry: ArtistMetaEntry {
                                country_iso2: c,
                                area_name: a,
                                begin_year: y,
                                artist_type: t,
                            },
                            fetched_at: at,
                        },
                    );
                }
                return out;
            }
            Err(e) => eprintln!("artist_meta: db read failed, using cache: {e}"),
        }
    }
    for k in keys {
        if let Some(s) = state.cache.get_json::<Stored>(&cache_key(k)).await {
            out.insert(k.clone(), s);
        }
    }
    out
}

async fn write_stored(state: &AppState, key: &str, s: &Stored) {
    if let Some(db) = &state.db {
        let r = sqlx::query(
            "INSERT INTO artist_meta (name_key, mbid, country_iso2, area_name, begin_year, artist_type, fetched_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7) \
             ON CONFLICT (name_key) DO UPDATE SET mbid=EXCLUDED.mbid, country_iso2=EXCLUDED.country_iso2, \
             area_name=EXCLUDED.area_name, begin_year=EXCLUDED.begin_year, artist_type=EXCLUDED.artist_type, \
             fetched_at=EXCLUDED.fetched_at",
        )
        .bind(key)
        .bind(&s.mbid)
        .bind(&s.entry.country_iso2)
        .bind(&s.entry.area_name)
        .bind(s.entry.begin_year)
        .bind(&s.entry.artist_type)
        .bind(s.fetched_at)
        .execute(db.pool())
        .await;
        match r {
            Ok(_) => return,
            Err(e) => eprintln!("artist_meta: db write failed, using cache: {e}"),
        }
    }
    state.cache.put_json(&cache_key(key), s, MISS_RETRY).await;
}

// ── worker ──────────────────────────────────────────────────────────────────

/// Start the single resolver task on first use, and again whenever it has
/// exited (needs a runtime, so not in the constructor).
fn ensure_worker(state: &Arc<AppState>) {
    let mut slot = state.artist_meta.worker.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().map_or(false, |h| !h.is_finished()) {
        return;
    }
    let rx = Arc::clone(&state.artist_meta.rx);
    let state = Arc::clone(state);
    *slot = Some(tokio::spawn(async move {
        let mut rx = rx.lock().await;
        loop {
            let Some(name) = rx.recv().await else { break };
            {
                let key = name_key(&name);
                let _claim = ClaimGuard(&state.artist_meta, key.clone());
                let tier1 = if state.artist_meta.lastfm_tier {
                    state.client.fetch_artist_mbid(&name).await.ok().flatten()
                } else {
                    None
                };
                match state.artist_meta.resolve(&name, tier1).await {
                    Outcome::Found { mbid, entry } => {
                        let s = Stored { mbid: Some(mbid), entry, fetched_at: Utc::now() };
                        write_stored(&state, &key, &s).await;
                    }
                    Outcome::Miss => {
                        let s = Stored {
                            mbid: None,
                            entry: ArtistMetaEntry::default(),
                            fetched_at: Utc::now(),
                        };
                        write_stored(&state, &key, &s).await;
                    }
                    Outcome::Transient => {}
                }
            }
        }
    }));
}

/// Answer from storage and enqueue what is missing. Never awaits MusicBrainz.
pub async fn snapshot(state: &Arc<AppState>, names: &[String]) -> ArtistMetaResponse {
    let keys: Vec<String> = names.iter().map(|n| name_key(n)).collect();
    let stored = read_stored(state, &keys).await;
    let now = Utc::now();
    let mut meta = BTreeMap::new();
    let mut pending = Vec::new();
    for (name, key) in names.iter().zip(&keys) {
        match stored.get(key) {
            Some(s) if !s.is_stale_miss(now) => {
                meta.insert(name.clone(), (!s.entry.is_empty()).then(|| s.entry.clone()));
            }
            _ => {
                meta.insert(name.clone(), None);
                pending.push(name.clone());
                let svc = &state.artist_meta;
                // Every poll with pending names checks the worker (cheap
                // JoinHandle check), so names already queued behind a dead
                // worker are drained again even when this poll claims nothing.
                ensure_worker(state);
                // Claim before sending so concurrent viewers don't double-fetch;
                // a name already in flight is simply pending.
                if svc.claim(key) {
                    if svc.tx.try_send(name.clone()).is_err() {
                        svc.release(key);
                    }
                }
            }
        }
    }
    ArtistMetaResponse { meta, pending }
}

// ── handler ─────────────────────────────────────────────────────────────────

fn bad(msg: &str) -> Response {
    let code = StatusCode::BAD_REQUEST;
    (code, Json(ErrorResponse { error: msg.to_string(), code: code.as_u16() })).into_response()
}

/// Parse repeated `name=` params. Blank names are skipped; duplicates collapse.
pub fn parse_names(raw: Option<&str>) -> Result<Vec<String>, &'static str> {
    let mut out: Vec<String> = Vec::new();
    for pair in raw.unwrap_or("").split('&') {
        let Some(v) = pair.strip_prefix("name=") else { continue };
        // Kept exactly as requested (untrimmed): it is the key in the response.
        let decoded = urlencoding::decode(&v.replace('+', " "))
            .map_err(|_| "name is not valid UTF-8")?
            .into_owned();
        if decoded.trim().is_empty() {
            continue;
        }
        if decoded.chars().count() > MAX_NAME_LEN {
            return Err("name too long");
        }
        if !out.contains(&decoded) {
            out.push(decoded);
        }
    }
    if out.is_empty() {
        return Err("at least one name= parameter is required");
    }
    if out.len() > MAX_NAMES {
        return Err("too many names (max 25)");
    }
    Ok(out)
}

pub async fn artist_meta_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let ip = crate::api::client_ip(&headers);
    if let Decision::Deny { retry_after_secs } = state.artist_meta.limiter.check(&ip) {
        let code = StatusCode::TOO_MANY_REQUESTS;
        let mut resp = (code, Json(ErrorResponse { error: "rate limit exceeded".into(), code: code.as_u16() }))
            .into_response();
        if let Ok(v) = header::HeaderValue::from_str(&retry_after_secs.to_string()) {
            resp.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return resp;
    }
    let names = match parse_names(raw.as_deref()) {
        Ok(n) => n,
        Err(m) => return bad(m),
    };
    (StatusCode::OK, Json(snapshot(&state, &names).await)).into_response()
}

/// `/api/status` value.
pub fn status_str(state: &AppState) -> Value {
    json!(if state.artist_meta.mb_ok() { "ok" } else { "degraded" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::routing::get;
    use axum::Router;
    use std::collections::HashMap;

    // Real MB response shapes, trimmed to the fields we read.
    const GROUP: &str = r#"{"id":"b2f8-1","name":"Entombed","type":"Group","country":"SE",
        "area":{"id":"x","name":"Sweden","iso-3166-1-codes":["SE"]},
        "life-span":{"begin":"1987","ended":false}}"#;
    const PERSON_AREA_ONLY: &str = r#"{"id":"p1","name":"Some Singer","type":"Person","country":null,
        "area":{"id":"y","name":"Europe","iso-3166-1-codes":null},
        "life-span":{"begin":null,"ended":false}}"#;
    const NOTHING: &str = r#"{"id":"n1","name":"Nobody","type":null,"country":null,"area":null,
        "life-span":{"begin":null,"end":null,"ended":false}}"#;

    #[test]
    fn parses_group_with_country_and_begin() {
        let e = parse_mb_artist(&serde_json::from_str(GROUP).unwrap());
        assert_eq!(e.country_iso2.as_deref(), Some("SE"));
        assert_eq!(e.area_name.as_deref(), Some("Sweden"));
        assert_eq!(e.begin_year, Some(1987));
        assert_eq!(e.artist_type.as_deref(), Some("Group"));
    }

    #[test]
    fn parses_person_with_only_area() {
        let e = parse_mb_artist(&serde_json::from_str(PERSON_AREA_ONLY).unwrap());
        assert_eq!(e.country_iso2, None);
        assert_eq!(e.area_name.as_deref(), Some("Europe"));
        assert_eq!(e.begin_year, None);
        assert_eq!(e.artist_type.as_deref(), Some("Person"));
    }

    #[test]
    fn parses_area_iso_when_country_missing_and_full_date_begin() {
        let v: Value = serde_json::from_str(
            r#"{"type":"Group","area":{"name":"Norway","iso-3166-1-codes":["NO"]},"life-span":{"begin":"2014-03-02"}}"#,
        )
        .unwrap();
        let e = parse_mb_artist(&v);
        assert_eq!(e.country_iso2.as_deref(), Some("NO"));
        assert_eq!(e.begin_year, Some(2014));
    }

    #[test]
    fn parses_no_country_artist_as_empty() {
        let e = parse_mb_artist(&serde_json::from_str(NOTHING).unwrap());
        assert!(e.is_empty());
    }

    #[test]
    fn name_key_matches_blend_normalizer_and_handles_symbols() {
        assert_eq!(name_key("The Cure"), name_key("cure"));
        assert_eq!(name_key("Zeal & Ardor"), name_key("Zeal and Ardor"));
        assert_eq!(name_key("!!!"), "!!!");
    }

    #[test]
    fn stale_miss_logic() {
        let now = Utc::now();
        let miss = |days: i64| Stored {
            mbid: None,
            entry: ArtistMetaEntry::default(),
            fetched_at: now - chrono::Duration::days(days),
        };
        assert!(!miss(29).is_stale_miss(now));
        assert!(miss(31).is_stale_miss(now));
        let hit = Stored {
            mbid: Some("m".into()),
            entry: ArtistMetaEntry { country_iso2: Some("SE".into()), ..Default::default() },
            fetched_at: now - chrono::Duration::days(400),
        };
        assert!(!hit.is_stale_miss(now), "hits never expire");
    }

    #[test]
    fn parse_names_decodes_dedupes_and_enforces_limits() {
        let n = parse_names(Some("name=Crosby%2C+Stills+%26+Nash&name=B&name=B&other=1&name=")).unwrap();
        assert_eq!(n, vec!["Crosby, Stills & Nash".to_string(), "B".to_string()]);
        assert!(parse_names(None).is_err());
        let ok: String = (0..25).map(|i| format!("name=a{i}&")).collect();
        assert_eq!(parse_names(Some(&ok)).unwrap().len(), 25);
        let too_many: String = (0..26).map(|i| format!("name=a{i}&")).collect();
        assert!(parse_names(Some(&too_many)).is_err());
        assert!(parse_names(Some(&format!("name={}", "x".repeat(201)))).is_err());
    }

    async fn mock_mb() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    let query = q.get("query").cloned().unwrap_or_default().to_lowercase();
                    if query.contains("nobody") {
                        return Json(json!({"artists":[{"id":"n","score":40}]}));
                    }
                    let mut hit: Value = serde_json::from_str(GROUP).unwrap();
                    hit["score"] = json!(96);
                    Json(json!({"artists":[hit]}))
                }),
            )
            .route(
                "/:mbid",
                get(|axum::extract::Path(mbid): axum::extract::Path<String>| async move {
                    if mbid == "gone" {
                        return (StatusCode::NOT_FOUND, Json(json!({"error":"Not Found"}))).into_response();
                    }
                    if mbid == "boom" {
                        return (StatusCode::SERVICE_UNAVAILABLE, "slow down").into_response();
                    }
                    Json(serde_json::from_str::<Value>(GROUP).unwrap()).into_response()
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/")
    }

    fn svc(url: String) -> ArtistMetaService {
        ArtistMetaService::build(Arc::new(ListenBrainzClient::with_urls("unused".into(), url)), false)
    }

    #[tokio::test]
    async fn resolve_by_mbid_search_miss_and_transient() {
        let s = svc(mock_mb().await);
        match s.resolve("Entombed", Some("abc".into())).await {
            Outcome::Found { mbid, entry } => {
                assert_eq!(mbid, "abc");
                assert_eq!(entry.country_iso2.as_deref(), Some("SE"));
            }
            o => panic!("{o:?}"),
        }
        // Stale Last.fm mbid (404) falls back to search.
        assert!(matches!(s.resolve("Entombed", Some("gone".into())).await, Outcome::Found { .. }));
        // Search below the score floor is a definitive miss.
        assert_eq!(s.resolve("Nobody", None).await, Outcome::Miss);
        // 503 is transient and flips degraded; a later success restores ok.
        assert_eq!(s.resolve("Entombed", Some("boom".into())).await, Outcome::Transient);
        assert!(!s.mb_ok());
        assert!(matches!(s.resolve("Entombed", None).await, Outcome::Found { .. }));
        assert!(s.mb_ok());
    }

    #[tokio::test]
    async fn low_priority_yields_to_blend_then_proceeds() {
        let s = svc(mock_mb().await);
        // Simulate a queued blend lookup: low priority must not take the permit.
        s.lb.test_set_blend_waiting(1);
        let base = s.lb.mb_base_url().to_string();
        let r = s.lb.mb_get_low_priority(&base, &[("fmt", "json")], Duration::from_millis(400)).await;
        assert_eq!(r.unwrap_err(), MbError::Starved);
        s.lb.test_set_blend_waiting(0);
        let r = s.lb.mb_get_low_priority(&base, &[("fmt", "json")], Duration::from_millis(400)).await;
        assert!(r.is_ok());
    }

    fn test_state(lb_url: String) -> Arc<AppState> {
        use crate::{cache, lastfm::LastfmClient, listenbrainz::CandidateSource, metrics, ratelimit};
        let lb = Arc::new(ListenBrainzClient::with_urls("unused".into(), lb_url));
        Arc::new(AppState {
            client: Arc::new(LastfmClient::with_keys(vec!["TESTKEY".into()], None)),
            spotify: None,
            candidate_source: CandidateSource::Lastfm,
            listenbrainz: None,
            artist_meta: ArtistMetaService::build(lb, false),
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
    async fn snapshot_cached_immediately_pending_for_uncached_then_filled_no_db() {
        let st = test_state(mock_mb().await);
        // Pre-seed the CacheStore (the no-DB storage path).
        let seeded = Stored {
            mbid: Some("m".into()),
            entry: ArtistMetaEntry { country_iso2: Some("FI".into()), ..Default::default() },
            fetched_at: Utc::now(),
        };
        st.cache.put_json(&cache_key(&name_key("Seeded Band")), &seeded, MISS_RETRY).await;
        // Fresh miss: returned as null and NOT pending.
        let miss = Stored { mbid: None, entry: ArtistMetaEntry::default(), fetched_at: Utc::now() };
        st.cache.put_json(&cache_key(&name_key("Known Miss")), &miss, MISS_RETRY).await;

        let names = vec!["Seeded Band".to_string(), "Known Miss".to_string(), "Entombed".to_string()];
        let r = snapshot(&st, &names).await;
        assert_eq!(r.meta["Seeded Band"].as_ref().unwrap().country_iso2.as_deref(), Some("FI"));
        assert!(r.meta["Known Miss"].is_none());
        assert!(r.meta["Entombed"].is_none());
        assert_eq!(r.pending, vec!["Entombed".to_string()]);

        // A concurrent second request dedupes (still pending, one queue entry).
        let r2 = snapshot(&st, &["Entombed".to_string()]).await;
        assert_eq!(r2.pending, vec!["Entombed".to_string()]);

        // Poll until the background worker has stored it (CacheStore).
        let mut filled = None;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let r = snapshot(&st, &["Entombed".to_string()]).await;
            if r.pending.is_empty() {
                filled = r.meta["Entombed"].clone();
                break;
            }
        }
        let e = filled.expect("resolved via mock MB and stored in CacheStore");
        assert_eq!(e.country_iso2.as_deref(), Some("SE"));
        assert_eq!(e.begin_year, Some(1987));
    }

    #[tokio::test]
    async fn postgres_roundtrip_and_stale_miss_retry() {
        // Live-Postgres test: skipped cleanly when DATABASE_URL is unset.
        if std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty()).is_none() {
            return;
        }
        let db = Arc::new(crate::db::Db::connect().await.expect("db"));
        // Migrations run in the background; wait for the table.
        let mut ready = false;
        for _ in 0..60 {
            if sqlx::query("SELECT 1 FROM artist_meta LIMIT 1").execute(db.pool()).await.is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        assert!(ready, "artist_meta migration applied");
        let mut st = test_state(mock_mb().await);
        Arc::get_mut(&mut st).unwrap().db = Some(db);
        let uniq = format!("pgtest {}", uuid::Uuid::new_v4());
        let key = name_key(&uniq);
        let hit = Stored {
            mbid: Some("m".into()),
            entry: ArtistMetaEntry {
                country_iso2: Some("SE".into()),
                area_name: Some("Sweden".into()),
                begin_year: Some(1999),
                artist_type: Some("Group".into()),
            },
            fetched_at: Utc::now(),
        };
        write_stored(&st, &key, &hit).await;
        let r = snapshot(&st, &[uniq.clone()]).await;
        assert!(r.pending.is_empty());
        assert_eq!(r.meta[&uniq].as_ref().unwrap().begin_year, Some(1999));
        // The DB (not the cache) holds it.
        assert!(st.cache.get_json::<Stored>(&cache_key(&key)).await.is_none());
        // A 31-day-old miss is pending again; a 1-day-old miss is not.
        let old = Stored { mbid: None, entry: ArtistMetaEntry::default(), fetched_at: Utc::now() - chrono::Duration::days(31) };
        write_stored(&st, &key, &old).await;
        assert_eq!(snapshot(&st, &[uniq.clone()]).await.pending, vec![uniq.clone()]);
    }

    #[tokio::test]
    async fn worker_is_respawned_after_it_dies_and_claims_do_not_stick() {
        let st = test_state(mock_mb().await);
        let first = snapshot(&st, &["Entombed".to_string()]).await;
        assert_eq!(first.pending.len(), 1);
        // Kill the worker (as a panic would), then ask again.
        let h = st.artist_meta.worker.lock().unwrap().take().unwrap();
        h.abort();
        let _ = h.await;
        let mut filled = None;
        for _ in 0..60 {
            let r = snapshot(&st, &["Entombed".to_string(), "Other Band".to_string()]).await;
            if r.pending.is_empty() {
                filled = r.meta["Entombed"].clone();
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert!(filled.is_some(), "a respawned worker resolved the queued names");
    }

    #[tokio::test]
    async fn poll_only_of_already_queued_names_respawns_dead_worker() {
        let st = test_state(mock_mb().await);
        // current_thread runtime: the freshly spawned worker has not run yet, so
        // the name is claimed and still sitting in the channel when we kill it.
        let first = snapshot(&st, &["Entombed".to_string()]).await;
        assert_eq!(first.pending.len(), 1);
        let h = st.artist_meta.worker.lock().unwrap().take().unwrap();
        h.abort();
        let _ = h.await;
        // Poll contains ONLY the already-claimed name (claim() fails for it).
        let mut filled = None;
        for _ in 0..60 {
            let r = snapshot(&st, &["Entombed".to_string()]).await;
            if r.pending.is_empty() {
                filled = r.meta["Entombed"].clone();
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert!(filled.is_some(), "poll-only request must respawn the worker");
    }

    #[tokio::test]
    async fn starved_marks_degraded_and_endpoint_rate_limits() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;
        let s = svc(mock_mb().await);
        s.note(Some(MbError::Starved));
        assert!(!s.mb_ok(), "starvation must be visible on /api/status");
        let app = crate::build_router(test_state("unused".into()));
        let mut last = StatusCode::OK;
        for _ in 0..70 {
            last = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/artist-meta?name=zzz")
                        .header("x-forwarded-for", "198.51.100.7")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
                .status();
            if last == StatusCode::TOO_MANY_REQUESTS {
                break;
            }
        }
        assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn parse_names_keeps_key_exactly_as_requested() {
        let n = parse_names(Some("name=%20Padded%20&name=+++")).unwrap();
        assert_eq!(n, vec![" Padded ".to_string()]);
    }

    #[tokio::test]
    async fn endpoint_rejects_empty_and_over_25() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;
        let app = crate::build_router(test_state("unused".into()));
        let status_of = |uri: String| {
            let app = app.clone();
            async move {
                app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
            }
        };
        assert_eq!(status_of("/api/artist-meta".into()).await, StatusCode::BAD_REQUEST);
        let many: String = (0..26).map(|i| format!("name=a{i}&")).collect();
        assert_eq!(status_of(format!("/api/artist-meta?{many}")).await, StatusCode::BAD_REQUEST);
    }
}
