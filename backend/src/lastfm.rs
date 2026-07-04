use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fmt;
use dashmap::DashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use serde_json::Value;
use std::time::SystemTime;
use crate::models::{SimilarArtist, TrackInfoResponse};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TopArtistsResponse {
    pub topartists: TopArtists,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LastfmErrorResponse {
    pub error: u32,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TopArtists {
    #[serde(default)]
    pub artist: Vec<Artist>,
    #[serde(rename = "@attr", default)]
    pub attr: Option<TopArtistsAttr>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct TopArtistsAttr {
    pub total: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UserInfoResponse {
    pub user: UserInfo,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UserInfo {
    pub playcount: Option<String>,
    /// Lifetime distinct-artist count. Present in current user.getinfo responses;
    /// Option-guarded in case an API version omits it (we fall back to the
    /// gettopartists @attr.total in that case).
    pub artist_count: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SimilarArtistsResponse {
    pub similarartists: SimilarArtists,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SimilarArtists {
    pub artist: Vec<Artist>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Artist {
    pub name: String,
    pub mbid: Option<String>,
    pub url: String,
    pub playcount: Option<String>,
    #[serde(rename = "match")]
    pub match_score: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum TimePeriod {
    SevenDay,
    OneMonth,
    ThreeMonth,
    SixMonth,
    TwelveMonth,
    Overall,
}

impl fmt::Display for TimePeriod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            TimePeriod::SevenDay    => "7day",
            TimePeriod::OneMonth    => "1month",
            TimePeriod::ThreeMonth  => "3month",
            TimePeriod::SixMonth    => "6month",
            TimePeriod::TwelveMonth => "12month",
            TimePeriod::Overall     => "overall",
        };
        write!(f, "{}", s)
    }
}

// ── Track API types ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TopTracksResponse {
    pub toptracks: TopTracks,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TopTracks {
    #[serde(default)]
    pub track: Vec<TopTrack>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TopTrack {
    pub name: String,
    pub playcount: Option<String>,
    pub artist: TrackArtistRef,
}


#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackArtistRef {
    pub name: String,
}

const LASTFM_API_URL: &str = "http://ws.audioscrobbler.com/2.0/";

/// Base Last.fm API URL, overridable via `LASTFM_API_BASE` — same env var and
/// fallback pattern as `get_session`'s `LASTFM_API_BASE` override, extended to
/// the two methods (`fetch_user_top_artists`, `fetch_user_info`) that need a
/// mockable endpoint for the user-not-found integration test. Unset in
/// production, so this is a no-op there (falls back to the real URL).
fn lastfm_api_base() -> String {
    std::env::var("LASTFM_API_BASE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| LASTFM_API_URL.to_string())
}

/// A resolved Last.fm web-auth session (from `auth.getSession`).
#[derive(Debug, Clone)]
pub struct LastfmSession {
    /// Canonical-cased username as Last.fm returns it.
    pub username: String,
    /// Long-lived Last.fm session key (stored opaquely; not currently used for
    /// authenticated Last.fm calls, but kept so future features don't re-auth).
    pub session_key: String,
}

/// Build a Last.fm `api_sig`: sort the params by name, concatenate each
/// `name+value` with no separators, append the shared secret, and MD5-hex the
/// result (lowercase). `format`/`callback` are excluded by the caller. This is
/// the exact scheme documented at last.fm/api/webauth and is pure/unit-tested.
pub fn sign_params(params: &[(&str, &str)], secret: &str) -> String {
    use md5::{Digest, Md5};
    let mut sorted: Vec<&(&str, &str)> = params.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut buf = String::new();
    for (k, v) in sorted {
        buf.push_str(k);
        buf.push_str(v);
    }
    buf.push_str(secret);
    let digest = Md5::digest(buf.as_bytes());
    hex::encode(digest)
}

/// Max attempts in get_with_retry (1 initial + retries).
const MAX_REQUEST_ATTEMPTS: u32 = 4;

/// Last.fm signals rate-limit / transient failures as HTTP 200 with an
/// `{"error":N}` body (not a 5xx). These codes are worth backing off and retrying:
/// 29 = rate limit, 8 = operation failed, 11 = service offline, 16 = temporarily
/// unavailable. Other codes (e.g. 6 invalid params) are permanent — fail fast.
fn is_retryable_lastfm_error(code: u64) -> bool {
    matches!(code, 8 | 11 | 16 | 29)
}

/// Peek at a Last.fm JSON body for an `error` code without consuming it.
fn lastfm_error_code(text: &str) -> Option<u64> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_u64()))
}

/// Classified fetch failure. The pipeline fans out hundreds of calls and must
/// distinguish two failure modes to stay deterministic:
/// - `Transient`: rate-limit (Error 29), 5xx, or a network/body-read failure that
///   survived every retry. A *complete* result is impossible right now, so callers
///   fail the whole request rather than silently shipping a partial (and therefore
///   non-deterministic) candidate pool.
/// - `Permanent`: a 4xx, bad params, or a malformed/permanent-error body. The item
///   legitimately yields nothing; skipping it is deterministic and safe.
#[derive(Debug, Clone)]
pub enum LastfmError {
    Transient(String),
    Permanent(String),
}

impl LastfmError {
    pub fn is_transient(&self) -> bool {
        matches!(self, LastfmError::Transient(_))
    }
}

impl fmt::Display for LastfmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LastfmError::Transient(m) => write!(f, "transient Last.fm failure: {}", m),
            LastfmError::Permanent(m) => write!(f, "permanent Last.fm failure: {}", m),
        }
    }
}

impl std::error::Error for LastfmError {}

/// Is this (boxed) pipeline error a transient Last.fm failure? Transient means
/// "retry later, a complete result isn't possible now" — callers fail the request.
/// Anything else (permanent 4xx, or a serde parse error from a malformed body) is
/// deterministic and safe to skip; we default to non-transient so a parse error
/// never wedges the request into a permanent fail-closed state.
pub fn is_transient_error(err: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    err.downcast_ref::<LastfmError>().map_or(false, |e| e.is_transient())
}

/// Last.fm error code 6 ("Invalid parameter" — used for "user not found" on
/// `user.gettopartists`/`user.getinfo`) is a *permanent, user-facing* failure
/// distinct from every other permanent error: the username itself is wrong,
/// not the request. Marked as its own downcastable type (rather than folded
/// into `LastfmError::Permanent`'s opaque string) so callers all the way up to
/// the HTTP handler can distinguish "no such user" from a generic failure
/// without parsing error text.
#[derive(Debug, Clone)]
pub struct LastfmUserNotFound(pub String);

impl fmt::Display for LastfmUserNotFound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Last.fm user \"{}\" not found", self.0)
    }
}

impl std::error::Error for LastfmUserNotFound {}

/// Is this (boxed) pipeline error specifically a Last.fm "user not found"
/// (error code 6 on `user.gettopartists`/`user.getinfo`)? Distinct from
/// `is_transient_error`: this is permanent, but callers need to tell it apart
/// from other permanent failures to surface a 404 instead of a generic 500.
pub fn is_user_not_found_error(err: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    err.downcast_ref::<LastfmUserNotFound>().is_some()
}

/// One key in the rotation pool, with a cooldown clock. When Last.fm rate-limits
/// a key (Error 29) it's benched for a short window so the rotation skips it.
struct PooledKey {
    key: String,
    benched_until: Mutex<Option<Instant>>,
}

pub struct LastfmClient {
    pub client: Client,
    /// The primary key, embedded by every fetch method's URL builder. The pool
    /// rotation in `get_with_retry` swaps this out for another pooled key per
    /// attempt, so the methods themselves never need to know about the pool.
    pub api_key: String,
    keys: RwLock<Vec<Arc<PooledKey>>>,
    cursor: AtomicUsize,
    /// User-contributed keys only (owner/env keys excluded). Mirrored to
    /// `store_path` so the opt-in pool survives restarts/redeploys.
    contributed: RwLock<Vec<String>>,
    store_path: Option<PathBuf>,
    pub audit_cache: DashMap<String, (Instant, crate::models::ArtistInfoResponse)>,
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// How long a key sits out after tripping Last.fm's rate limit (Error 29).
const KEY_BENCH_SECS: u64 = 20;

impl LastfmClient {
    /// Single-key client (used for per-user custom-key requests). No persistence.
    pub fn new(api_key: String) -> Self {
        Self::with_keys(vec![api_key], None)
    }

    /// Multi-key client. The first key is the primary (used to build URLs); all
    /// keys join the rotation pool. Empty/blank/duplicate keys are dropped. When
    /// `store_path` is set, previously-contributed keys are loaded from it on boot
    /// and new contributions are written back, so the opt-in pool persists.
    pub fn with_keys(keys: Vec<String>, store_path: Option<PathBuf>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut pool: Vec<Arc<PooledKey>> = Vec::new();
        // Owner/env keys first (so the primary is an owner key).
        for k in keys {
            let k = k.trim().to_string();
            if k.is_empty() || !seen.insert(k.clone()) { continue; }
            pool.push(Arc::new(PooledKey { key: k, benched_until: Mutex::new(None) }));
        }
        // Then any persisted user-contributed keys.
        let mut contributed: Vec<String> = Vec::new();
        if let Some(path) = &store_path {
            if let Ok(text) = std::fs::read_to_string(path) {
                for line in text.lines() {
                    let k = line.trim().to_string();
                    if k.is_empty() || k.starts_with('#') || !seen.insert(k.clone()) { continue; }
                    pool.push(Arc::new(PooledKey { key: k.clone(), benched_until: Mutex::new(None) }));
                    contributed.push(k);
                }
                if !contributed.is_empty() {
                    println!("Loaded {} contributed key(s) from store", contributed.len());
                }
            }
        }
        let primary = pool.first().map(|p| p.key.clone()).unwrap_or_default();
        Self {
            client,
            api_key: primary,
            keys: RwLock::new(pool),
            cursor: AtomicUsize::new(0),
            contributed: RwLock::new(contributed),
            store_path,
            audit_cache: DashMap::new(),
        }
    }

    /// Add a key to the rotation pool at runtime (user-shared, opt-in). Persists
    /// the contributed set when a store path is configured. Returns the new pool
    /// size, or None if the key was empty or a duplicate.
    pub fn add_key(&self, key: String) -> Option<usize> {
        let key = key.trim().to_string();
        if key.is_empty() {
            return None;
        }
        let n = {
            let mut keys = self.keys.write().ok()?;
            if keys.iter().any(|k| k.key == key) {
                return None;
            }
            keys.push(Arc::new(PooledKey { key: key.clone(), benched_until: Mutex::new(None) }));
            keys.len()
        };
        if let Ok(mut c) = self.contributed.write() {
            c.push(key);
            self.persist(&c);
        }
        Some(n)
    }

    /// Write the user-contributed keys to the store file (one per line).
    /// Best-effort: a write failure is logged, never fatal.
    fn persist(&self, contributed: &[String]) {
        if let Some(path) = &self.store_path {
            if let Err(e) = std::fs::write(path, contributed.join("\n")) {
                eprintln!("KEY STORE: failed to persist contributed keys: {}", e);
            }
        }
    }

    pub fn key_count(&self) -> usize {
        self.keys.read().map(|k| k.len()).unwrap_or(0)
    }

    /// Round-robin pick of a non-benched key. If every key is benched, returns
    /// the next one anyway (a benched-but-usable key beats failing the request).
    fn pick_key(&self) -> Option<Arc<PooledKey>> {
        let keys = self.keys.read().ok()?;
        let n = keys.len();
        if n == 0 {
            return None;
        }
        let now = Instant::now();
        for _ in 0..n {
            let idx = self.cursor.fetch_add(1, Ordering::Relaxed) % n;
            let benched = keys[idx].benched_until.lock().ok()
                .and_then(|g| *g)
                .map_or(false, |t| t > now);
            if !benched {
                return Some(Arc::clone(&keys[idx]));
            }
        }
        let idx = self.cursor.fetch_add(1, Ordering::Relaxed) % n;
        Some(Arc::clone(&keys[idx]))
    }

    fn bench(&self, pk: &PooledKey) {
        if let Ok(mut g) = pk.benched_until.lock() {
            *g = Some(Instant::now() + Duration::from_secs(KEY_BENCH_SECS));
        }
    }

    /// GET with exponential backoff + jitter (base 1s → 2s → 4s, plus 0–500ms).
    ///
    /// Retries on: network errors, 5xx, AND Last.fm's HTTP-200 rate-limit/transient
    /// error bodies (`{"error":29}` etc.) — which previously slipped through the
    /// success path and broke deserialization downstream. The pipeline fans out
    /// hundreds of calls per discovery and *must* burst to finish inside the request
    /// budget, so we don't cap concurrency (that just serialized everything into a
    /// timeout); instead, when a burst trips the rate limit, each call backs off
    /// with independent jitter so the retries spread out instead of re-bursting in
    /// lockstep. Fails fast on 4xx and on permanent Last.fm error codes (the caller
    /// parses and surfaces those).
    async fn get_with_retry(&self, url: &str) -> Result<String, LastfmError> {
        let mut last_err = String::from("request never attempted");
        for attempt in 0u32..MAX_REQUEST_ATTEMPTS {
            // Rotate to a pooled key for this attempt. The caller built the URL
            // with the primary key; swap in the picked key when they differ.
            // (URLs carry a key, so they are never logged below.)
            let pk = match self.pick_key() {
                Some(p) => p,
                None => return Err(LastfmError::Transient("no Last.fm API key configured".into())),
            };
            let req_url = if pk.key == self.api_key {
                std::borrow::Cow::Borrowed(url)
            } else {
                std::borrow::Cow::Owned(
                    url.replace(&format!("api_key={}", self.api_key), &format!("api_key={}", pk.key)),
                )
            };
            match self.client.get(req_url.as_ref()).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        match resp.text().await {
                            Ok(text) => match lastfm_error_code(&text) {
                                // rate-limit / transient app error → back off and retry
                                Some(code) if is_retryable_lastfm_error(code) => {
                                    last_err = format!("Last.fm Error {} (rate/transient)", code);
                                    // Bench a rate-limited key so the rotation skips it.
                                    if code == 29 { self.bench(&pk); }
                                    eprintln!("Last.fm error {} on attempt {} — backing off", code, attempt + 1);
                                }
                                // permanent app error OR clean success → return body;
                                // the caller's own error check handles permanent errors.
                                _ => return Ok(text),
                            },
                            // Body read failed mid-stream (e.g. truncated/dropped
                            // connection) — transient, back off and retry.
                            Err(e) => {
                                last_err = format!("response body read error: {}", e);
                                eprintln!("Last.fm body read error on attempt {}: {}", attempt + 1, e);
                            }
                        }
                    } else if status.is_client_error() {
                        // 4xx — permanent, retrying won't help.
                        return Err(LastfmError::Permanent(format!("Last.fm HTTP {}", status)));
                    } else {
                        // 5xx — log and retry
                        last_err = format!("Last.fm HTTP {}", status);
                        eprintln!("Last.fm {} on attempt {}", status, attempt + 1);
                    }
                }
                Err(e) => {
                    eprintln!("Last.fm network error on attempt {}: {}", attempt + 1, e);
                    last_err = format!("network error: {}", e);
                }
            }
            // exponential backoff + jitter before the next attempt; skip after the last
            if attempt + 1 < MAX_REQUEST_ATTEMPTS {
                let base = 1000u64 * (1u64 << attempt); // 1s, 2s, 4s
                let jitter = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| (d.subsec_nanos() % 500) as u64)
                    .unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(base + jitter)).await;
            }
        }
        // Exhausted every retry on a retryable condition → transient. Callers
        // fail-closed on this so a rate-limited burst never yields a partial pool.
        Err(LastfmError::Transient(last_err))
    }

    pub async fn fetch_user_top_artists(
        &self,
        username: &str,
        limit: u32,
        period: TimePeriod,
    ) -> Result<TopArtistsResponse, BoxError> {
        let url = format!(
            "{}?method=user.gettopartists&user={}&api_key={}&period={}&format=json&limit={}",
            lastfm_api_base(), urlencoding::encode(username), self.api_key, period, limit
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            let err_msg: LastfmErrorResponse = serde_json::from_value(json)?;
            if err_msg.error == 6 {
                return Err(Box::new(LastfmUserNotFound(username.to_string())));
            }
            return Err(format!("Last.fm Error {}: {}", err_msg.error, err_msg.message).into());
        }
        Ok(serde_json::from_str(&resp_text)?)
    }

    pub async fn fetch_user_info(
        &self,
        username: &str,
    ) -> Result<UserInfoResponse, BoxError> {
        let url = format!(
            "{}?method=user.getinfo&user={}&api_key={}&format=json",
            lastfm_api_base(), urlencoding::encode(username), self.api_key
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            let err_msg: LastfmErrorResponse = serde_json::from_value(json)?;
            if err_msg.error == 6 {
                return Err(Box::new(LastfmUserNotFound(username.to_string())));
            }
            return Err(format!("Last.fm Error {}: {}", err_msg.error, err_msg.message).into());
        }
        Ok(serde_json::from_str(&resp_text)?)
    }

    pub async fn fetch_similar_artists(
        &self,
        artist_name: &str,
        limit: u32,
    ) -> Result<SimilarArtistsResponse, BoxError> {
        let url = format!(
            "{}?method=artist.getsimilar&artist={}&api_key={}&format=json&limit={}",
            LASTFM_API_URL, urlencoding::encode(artist_name), self.api_key, limit
        );
        let resp_text = self.get_with_retry(&url).await?;
        Ok(serde_json::from_str(&resp_text)?)
    }

    /// Resolve an artist's MusicBrainz ID via `artist.getinfo` (tier-1 of the
    /// ListenBrainz MBID resolution). No `username` — the `mbid` field is public,
    /// so this is cacheable/shareable across users. Returns `Ok(None)` when the
    /// artist has no mbid on file (deterministic miss → the caller falls back to
    /// MusicBrainz search); reuses the key pool + retry via `get_with_retry`.
    /// A parsed `{"error":N}` body yields `Ok(None)` (no mbid), not a hard error,
    /// so a single unresolvable seed never fails the additive LB path.
    pub async fn fetch_artist_mbid(&self, artist_name: &str) -> Result<Option<String>, BoxError> {
        let url = format!(
            "{}?method=artist.getinfo&artist={}&api_key={}&format=json",
            LASTFM_API_URL, urlencoding::encode(artist_name), self.api_key
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            return Ok(None);
        }
        Ok(json
            .get("artist")
            .and_then(|a| a.get("mbid"))
            .and_then(|m| m.as_str())
            .map(str::to_string)
            .filter(|m| !m.is_empty()))
    }

    pub async fn fetch_artist_info(
        &self,
        artist_name: &str,
        username: &str,
    ) -> Result<crate::models::ArtistInfoResponse, BoxError> {
        let cache_key = format!("{}:{}", artist_name, username);

        if let Some(entry) = self.audit_cache.get(&cache_key) {
            if entry.0.elapsed() < Duration::from_secs(86400) {
                return Ok(entry.1.clone());
            }
        }

        let url = format!(
            "{}?method=artist.getinfo&artist={}&username={}&api_key={}&format=json",
            LASTFM_API_URL, urlencoding::encode(artist_name), urlencoding::encode(username), self.api_key
        );
        let resp_text = self.get_with_retry(&url).await?;
        let response: crate::models::ArtistInfoResponse = serde_json::from_str(&resp_text)?;

        // Cap cache at 10,000 entries to prevent unbounded memory growth
        if self.audit_cache.len() >= 10_000 {
            if let Some(key) = self.audit_cache.iter().next().map(|e| e.key().clone()) {
                self.audit_cache.remove(&key);
            }
        }
        self.audit_cache.insert(cache_key, (Instant::now(), response.clone()));

        Ok(response)
    }

    pub async fn fetch_user_top_tracks(
        &self,
        username: &str,
        limit: u32,
        period: TimePeriod,
    ) -> Result<TopTracksResponse, BoxError> {
        let url = format!(
            "{}?method=user.gettoptracks&user={}&api_key={}&period={}&format=json&limit={}",
            LASTFM_API_URL, urlencoding::encode(username), self.api_key, period, limit
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: serde_json::Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            let err: LastfmErrorResponse = serde_json::from_value(json)?;
            return Err(format!("Last.fm Error {}: {}", err.error, err.message).into());
        }
        Ok(serde_json::from_str(&resp_text)?)
    }

    pub async fn fetch_track_info(
        &self,
        artist: &str,
        track: &str,
        username: &str,
    ) -> Result<TrackInfoResponse, BoxError> {
        let url = format!(
            "{}?method=track.getinfo&artist={}&track={}&username={}&api_key={}&format=json",
            LASTFM_API_URL,
            urlencoding::encode(artist),
            urlencoding::encode(track),
            urlencoding::encode(username),
            self.api_key
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: serde_json::Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            return Err("track not found".into());
        }
        Ok(serde_json::from_str(&resp_text)?)
    }

    pub async fn fetch_artist_top_tracks(
        &self,
        artist: &str,
        limit: u32,
    ) -> Result<TopTracksResponse, BoxError> {
        let url = format!(
            "{}?method=artist.gettoptracks&artist={}&api_key={}&format=json&limit={}",
            LASTFM_API_URL, urlencoding::encode(artist), self.api_key, limit
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: serde_json::Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            return Ok(TopTracksResponse { toptracks: TopTracks { track: vec![] } });
        }
        Ok(serde_json::from_str(&resp_text).unwrap_or_else(|_| TopTracksResponse {
            toptracks: TopTracks { track: vec![] },
        }))
    }

    /// Infallible tag fetch — returns `[]` on any failure. Used by the track
    /// pipeline, where tags are a soft signal and a miss is tolerable.
    pub async fn fetch_artist_tags(&self, artist: &str) -> Vec<String> {
        self.fetch_artist_tags_checked(artist).await.unwrap_or_default()
    }

    /// Tag fetch that surfaces transient failures so the artist-discovery pipeline
    /// can fail-closed (a dropped tag fetch would change taste-alignment ranking
    /// non-deterministically). A permanent app error → `[]` (deterministically no tags).
    pub async fn fetch_artist_tags_checked(&self, artist: &str) -> Result<Vec<String>, BoxError> {
        #[derive(serde::Deserialize)]
        struct Resp { toptags: TopTags }
        #[derive(serde::Deserialize)]
        struct TopTags { #[serde(default)] tag: Vec<TagEntry> }
        #[derive(serde::Deserialize)]
        struct TagEntry { name: String }

        let url = format!(
            "{}?method=artist.gettoptags&artist={}&api_key={}&format=json",
            LASTFM_API_URL, urlencoding::encode(artist), self.api_key
        );
        let text = self.get_with_retry(&url).await?;
        let json: serde_json::Value = serde_json::from_str(&text)?;
        if json.get("error").is_some() { return Ok(vec![]); }
        Ok(serde_json::from_str::<Resp>(&text)
            .map(|r| r.toptags.tag.into_iter().take(6).map(|t| t.name).collect())
            .unwrap_or_default())
    }

    /// Fetch a Last.fm web-auth session for a callback `token` (see the pinned
    /// auth flow). Requires the shared secret to build the MD5 `api_sig`. Returns
    /// the (canonical-cased) username and the Last.fm session key. `base_url` is
    /// injectable so tests can point at a mock server; production passes the real
    /// endpoint via `get_session`.
    pub async fn get_session_at(
        &self,
        base_url: &str,
        token: &str,
        secret: &str,
    ) -> Result<LastfmSession, LastfmError> {
        // Signed params (format/callback excluded from the signature per spec).
        let params: Vec<(&str, &str)> = vec![
            ("api_key", self.api_key.as_str()),
            ("method", "auth.getSession"),
            ("token", token),
        ];
        let api_sig = sign_params(&params, secret);
        let url = format!(
            "{}?method=auth.getSession&api_key={}&token={}&api_sig={}&format=json",
            base_url,
            urlencoding::encode(&self.api_key),
            urlencoding::encode(token),
            api_sig,
        );
        let text = self.get_with_retry(&url).await?;
        let json: Value = serde_json::from_str(&text)
            .map_err(|e| LastfmError::Permanent(format!("auth.getSession parse error: {e}")))?;
        if let Some(code) = json.get("error").and_then(|e| e.as_u64()) {
            let msg = json.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
            // Auth errors (invalid/expired token = 4/14/15) are permanent for this token.
            return Err(LastfmError::Permanent(format!("Last.fm auth error {code}: {msg}")));
        }
        let name = json
            .get("session")
            .and_then(|s| s.get("name"))
            .and_then(|n| n.as_str())
            .ok_or_else(|| LastfmError::Permanent("auth.getSession missing session.name".into()))?
            .to_string();
        let key = json
            .get("session")
            .and_then(|s| s.get("key"))
            .and_then(|k| k.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(LastfmSession { username: name, session_key: key })
    }

    /// Production entry point for `get_session_at` — hits the real Last.fm API.
    /// `LASTFM_API_BASE` overrides the endpoint (used only by integration tests
    /// to point the auth flow at a local mock server); unset → the real API.
    pub async fn get_session(&self, token: &str, secret: &str) -> Result<LastfmSession, LastfmError> {
        let base = std::env::var("LASTFM_API_BASE").ok().filter(|s| !s.is_empty());
        let base = base.as_deref().unwrap_or(LASTFM_API_URL);
        self.get_session_at(base, token, secret).await
    }

    pub async fn fetch_tag_top_artists(
        &self,
        tag: &str,
        limit: u32,
    ) -> Result<Vec<SimilarArtist>, BoxError> {
        #[derive(serde::Deserialize)]
        struct TagTopArtistsResponse {
            topartists: TagTopArtists,
        }
        #[derive(serde::Deserialize)]
        struct TagTopArtists {
            #[serde(default)]
            artist: Vec<SimilarArtist>,
        }
        let url = format!(
            "{}?method=tag.gettopartists&tag={}&api_key={}&format=json&limit={}",
            LASTFM_API_URL, urlencoding::encode(tag), self.api_key, limit
        );
        let resp_text = self.get_with_retry(&url).await?;
        let response: TagTopArtistsResponse = serde_json::from_str(&resp_text)?;
        Ok(response.topartists.artist)
    }
}

#[cfg(test)]
mod error_classification_tests {
    use super::*;

    // A full HTTP-level test of the transient (rate-limit) path would need to
    // exhaust `get_with_retry`'s real backoff sleeps (~7s across 4 attempts) —
    // too slow for a unit suite. This locks in the same distinction at the
    // classifier level instead: user-not-found is permanent-and-user-facing,
    // never transient; a transient failure is never mistaken for user-not-found.
    #[test]
    fn user_not_found_is_not_transient() {
        let err = LastfmUserNotFound("someuser".to_string());
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(err);
        assert!(is_user_not_found_error(boxed.as_ref()));
        assert!(!is_transient_error(boxed.as_ref()));
    }

    #[test]
    fn transient_error_is_not_user_not_found() {
        let err = LastfmError::Transient("Last.fm Error 29 (rate/transient)".to_string());
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(err);
        assert!(is_transient_error(boxed.as_ref()));
        assert!(!is_user_not_found_error(boxed.as_ref()));
    }

    #[test]
    fn permanent_non_user_error_is_neither() {
        let err = LastfmError::Permanent("Last.fm HTTP 400".to_string());
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(err);
        assert!(!is_transient_error(boxed.as_ref()));
        assert!(!is_user_not_found_error(boxed.as_ref()));
    }
}

#[cfg(test)]
mod auth_sign_tests {
    use super::*;

    // Known-answer vector: params sorted → "api_keyKEYmethodauth.getSessiontokenTOK"
    // + secret "SEC", MD5-hex. Precomputed independently.
    #[test]
    fn api_sig_matches_lastfm_scheme() {
        let params = vec![
            ("api_key", "KEY"),
            ("method", "auth.getSession"),
            ("token", "TOK"),
        ];
        let sig = sign_params(&params, "SEC");
        // md5("api_keyKEYmethodauth.getSessiontokenTOKSEC")
        assert_eq!(sig, "35187b6f9d029664a2b1650902ea3d54");
        // 32 lowercase hex chars.
        assert_eq!(sig.len(), 32);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn api_sig_is_order_independent() {
        // Same params, different input order → identical signature (params sorted).
        let a = sign_params(&[("b", "2"), ("a", "1")], "s");
        let b = sign_params(&[("a", "1"), ("b", "2")], "s");
        assert_eq!(a, b);
    }
}
