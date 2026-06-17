use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fmt;
use dashmap::DashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicUsize, Ordering};
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
    pub audit_cache: DashMap<String, (Instant, crate::models::ArtistInfoResponse)>,
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// How long a key sits out after tripping Last.fm's rate limit (Error 29).
const KEY_BENCH_SECS: u64 = 20;

impl LastfmClient {
    /// Single-key client (used for per-user custom-key requests).
    pub fn new(api_key: String) -> Self {
        Self::with_keys(vec![api_key])
    }

    /// Multi-key client. The first key is the primary (used to build URLs); all
    /// keys join the rotation pool. Empty/blank keys are dropped.
    pub fn with_keys(keys: Vec<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        let cleaned: Vec<String> = keys.into_iter()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect();
        let primary = cleaned.first().cloned().unwrap_or_default();
        let pooled = cleaned.into_iter()
            .map(|k| Arc::new(PooledKey { key: k, benched_until: Mutex::new(None) }))
            .collect();
        Self {
            client,
            api_key: primary,
            keys: RwLock::new(pooled),
            cursor: AtomicUsize::new(0),
            audit_cache: DashMap::new(),
        }
    }

    /// Add a key to the rotation pool at runtime (user-shared, opt-in).
    /// Returns the new pool size, or None if the key was empty or a duplicate.
    pub fn add_key(&self, key: String) -> Option<usize> {
        let key = key.trim().to_string();
        if key.is_empty() {
            return None;
        }
        let mut keys = self.keys.write().ok()?;
        if keys.iter().any(|k| k.key == key) {
            return None;
        }
        keys.push(Arc::new(PooledKey { key, benched_until: Mutex::new(None) }));
        Some(keys.len())
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
            LASTFM_API_URL, urlencoding::encode(username), self.api_key, period, limit
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            let err_msg: LastfmErrorResponse = serde_json::from_value(json)?;
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
            LASTFM_API_URL, urlencoding::encode(username), self.api_key
        );
        let resp_text = self.get_with_retry(&url).await?;
        let json: Value = serde_json::from_str(&resp_text)?;
        if json.get("error").is_some() {
            let err_msg: LastfmErrorResponse = serde_json::from_value(json)?;
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
