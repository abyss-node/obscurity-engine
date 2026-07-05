use reqwest::Client;
use serde::Deserialize;
use tokio::sync::{Mutex, Semaphore};
use std::time::{Duration, Instant};

/// Bounds concurrent Spotify `/search` calls, even within one discovery's
/// `join_all` fan-out over ~25 artists. Keeps us well under Spotify's
/// account-wide rate limit instead of firing everything at once.
const SPOTIFY_SEARCH_CONCURRENCY: usize = 4;

pub struct SpotifyClient {
    client: Client,
    client_id: String,
    client_secret: String,
    token: Mutex<Option<(String, Instant)>>,
    /// Bounds concurrent calls to `/search`.
    search_sem: Semaphore,
    /// Set after a 429 from `/search`; while in the future, `resolve_artist_links`
    /// short-circuits without calling Spotify at all (sticky-rate-limit cooldown).
    rate_limited_until: Mutex<Option<Instant>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// Parse a Spotify search/lookup response, capturing the real HTTP status and a
/// body snippet on failure. The old code did `resp.json::<T>()` directly, so a
/// non-2xx error body (e.g. a 429/403 whose JSON shape is `{"error": ...}`, not
/// the search shape) surfaced only as a misleading "error decoding response
/// body" with no status. Now the status and body are logged, so a broken
/// Spotify integration is actually diagnosable. Still best-effort: any failure
/// returns None so the caller just omits that link.
async fn parse_spotify_response<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
) -> Option<T> {
    let status = resp.status();
    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Spotify {ctx}: reading body failed (HTTP {status}): {e}");
            return None;
        }
    };
    if !status.is_success() {
        let snippet: String = body.chars().take(200).collect();
        eprintln!("Spotify {ctx}: HTTP {status} — {snippet}");
        return None;
    }
    match serde_json::from_str::<T>(&body) {
        Ok(v) => Some(v),
        Err(e) => {
            let snippet: String = body.chars().take(200).collect();
            eprintln!("Spotify {ctx}: JSON parse failed: {e} — body: {snippet}");
            None
        }
    }
}


/// Returned by `lookup_track` — everything the frontend needs for preview + open-in-spotify.
#[derive(serde::Serialize, Debug)]
pub struct SpotifyTrackPreview {
    pub id: String,
    pub preview_url: Option<String>,
    pub spotify_url: String,
}

const API_BASE: &str = "https://api.spotify.com/v1";

/// Listen/find links for one artist. Every field is optional: the frontend
/// only renders a link when its URL is present, so a failed lookup just means
/// that button doesn't show — never a dead link.
///
/// `this_is_url` is always `None` now (the "This Is {artist}" playlist lookup
/// was dropped 2026-07-05 to halve Spotify `/search` call volume — see
/// `resolve_artist_links`); the field is kept so the response shape and the
/// frontend (which already hides the button when this is absent) don't need
/// to change.
#[derive(serde::Serialize, serde::Deserialize, Debug, Default, Clone)]
pub struct ArtistLinks {
    pub spotify_url: Option<String>,
    pub this_is_url: Option<String>,
    pub bandcamp_url: Option<String>,
}

impl SpotifyClient {
    /// Resolve Spotify listen/find links for an artist. Best-effort: a failed
    /// lookup leaves that field None.
    /// (Bandcamp is resolved client-side as a search link — its public API
    /// 403s datacenter IPs, so there's no point calling it from the server.
    /// The "This Is {artist}" playlist lookup was dropped 2026-07-05 — it
    /// doubled Spotify `/search` call volume for a lower-value link.)
    ///
    /// Returns `None` when resolution was NOT attempted this call — i.e. a
    /// sticky-429 cooldown is active (see `is_rate_limited`). Callers must not
    /// cache a `None`. Returns `Some(links)` whenever a lookup was actually
    /// attempted, even if `links.spotify_url` is itself `None` (a genuine
    /// negative result, safe — and intended — to cache).
    pub async fn resolve_artist_links(&self, artist: &str) -> Option<ArtistLinks> {
        if self.is_rate_limited().await {
            return None;
        }
        // A token-mint failure (bad creds / network) means /search was never
        // reached either — same "not attempted" bucket as the cooldown case,
        // so the caller doesn't cache a false negative for every artist during
        // an outage.
        let Ok(token) = self.get_token().await else {
            return None;
        };
        let _permit = self.search_sem.acquire().await;
        let spotify_url = self.search_artist_url(&token, artist).await;
        Some(ArtistLinks { spotify_url, this_is_url: None, bandcamp_url: None })
    }

    /// Top artist match → its open.spotify.com/artist URL.
    async fn search_artist_url(&self, token: &str, artist: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Resp { artists: Items }
        #[derive(Deserialize)]
        struct Items { items: Vec<ArtistHit> }
        #[derive(Deserialize)]
        struct ArtistHit { name: String, external_urls: ExternalUrls }
        #[derive(Deserialize)]
        struct ExternalUrls { spotify: String }

        let resp = match self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(token)
            .query(&[("q", artist), ("type", "artist"), ("limit", "3")])
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Spotify search_artist_url request failed for '{artist}': {e}");
                return None;
            }
        };
        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let secs = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(30);
            self.mark_rate_limited(secs).await;
            eprintln!(
                "Spotify search_artist_url rate-limited (429) for '{artist}': retry-after={secs}s — entering cooldown, skipping Spotify calls until then"
            );
            return None;
        }
        let data: Resp = parse_spotify_response(resp, &format!("search_artist_url '{artist}'")).await?;
        // Prefer an exact (case-insensitive) name match; fall back to the top hit.
        let items = data.artists.items;
        items.iter()
            .find(|a| a.name.eq_ignore_ascii_case(artist))
            .or_else(|| items.first())
            .map(|a| a.external_urls.spotify.clone())
    }

    /// Start (or extend) the sticky-429 cooldown. `retry_after_secs` is
    /// clamped to at least 1 so a `0`/unparsed header can't produce a no-op
    /// cooldown.
    async fn mark_rate_limited(&self, retry_after_secs: u64) {
        *self.rate_limited_until.lock().await =
            Some(Instant::now() + Duration::from_secs(retry_after_secs.max(1)));
    }

    /// Whether a 429 cooldown is currently active. Clears (and returns
    /// `false` for) an expired cooldown so the `Mutex` doesn't hold a stale
    /// `Some` forever.
    pub async fn is_rate_limited(&self) -> bool {
        let mut guard = self.rate_limited_until.lock().await;
        match *guard {
            Some(until) if until > Instant::now() => true,
            Some(_) => {
                *guard = None;
                false
            }
            None => false,
        }
    }


    /// Look up a track by artist + name using client-credentials auth.
    /// Returns id, preview_url (30-second clip, may be None), and the spotify.com URL.
    pub async fn lookup_track(&self, artist: &str, track: &str) -> Option<SpotifyTrackPreview> {
        let token = self.get_token().await.ok()?;
        let query = format!("track:\"{}\" artist:\"{}\"", track, artist);

        #[derive(Deserialize)]
        struct Resp { tracks: Items }
        #[derive(Deserialize)]
        struct Items { items: Vec<FullTrack> }
        #[derive(Deserialize)]
        struct FullTrack {
            id: String,
            preview_url: Option<String>,
            external_urls: ExternalUrls,
        }
        #[derive(Deserialize)]
        struct ExternalUrls { spotify: String }

        let resp = match self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(&token)
            .query(&[("q", query.as_str()), ("type", "track"), ("limit", "1")])
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Spotify lookup_track request failed for '{artist}' - '{track}': {e}");
                return None;
            }
        };

        let data: Resp = parse_spotify_response(resp, &format!("lookup_track '{artist}' - '{track}'")).await?;
        let t = data.tracks.items.into_iter().next()?;
        Some(SpotifyTrackPreview { id: t.id, preview_url: t.preview_url, spotify_url: t.external_urls.spotify })
    }

    pub fn new(client_id: String, client_secret: String) -> Self {
        // Give the Spotify client the same bounded timeouts as the Last.fm one —
        // Client::new() has no timeout, so a stalled Spotify request could hang
        // indefinitely (and, via /api/status health(), stall that endpoint too).
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self {
            client,
            client_id,
            client_secret,
            token: Mutex::new(None),
            search_sem: Semaphore::new(SPOTIFY_SEARCH_CONCURRENCY),
            rate_limited_until: Mutex::new(None),
        }
    }

    /// Mint (or reuse the cached) Spotify app token. On failure — bad creds,
    /// network error, non-2xx from Spotify — logs one line via eprintln! so a
    /// silently-broken Spotify integration is visible in the logs (FIX 3,
    /// 2026-07-05: previously this returned Err with zero log output).
    async fn get_token(&self) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut cache = self.token.lock().await;
        if let Some((token, obtained_at)) = cache.as_ref() {
            if obtained_at.elapsed() < Duration::from_secs(3500) {
                return Ok(token.clone());
            }
        }
        let send_result = self.client
            .post("https://accounts.spotify.com/api/token")
            .basic_auth(&self.client_id, Some(&self.client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await;
        let resp = match send_result {
            Ok(r) => match r.error_for_status() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("Spotify token mint failed: {e}");
                    return Err(e.into());
                }
            },
            Err(e) => {
                eprintln!("Spotify token mint failed: {e}");
                return Err(e.into());
            }
        };
        let data: TokenResponse = resp.json().await?;
        *cache = Some((data.access_token.clone(), Instant::now()));
        Ok(data.access_token)
    }

    /// Whether the configured Spotify credentials actually work — attempts a
    /// token mint (reusing the cached token after the first successful call,
    /// so this never hammers Spotify). Used by FIX 4 (/api/status) so "ok"
    /// means the creds were verified, not merely that env vars were set.
    pub async fn health(&self) -> bool {
        self.get_token().await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `is_rate_limited` reflects an active cooldown, and clears the marker
    /// once it's expired — without a real sleep. `mark_rate_limited` sets a
    /// std::time::Instant deadline (not tokio's virtual clock), so
    /// `tokio::time::pause()` can't fast-forward it; this test lives in the
    /// same module and instead mutates the private field directly to a
    /// past `Instant`, which exercises the exact same read path.
    #[tokio::test]
    async fn rate_limit_cooldown_tracks_and_expires() {
        let client = SpotifyClient::new("id".into(), "secret".into());
        assert!(!client.is_rate_limited().await, "fresh client should not be rate-limited");

        client.mark_rate_limited(60).await;
        assert!(client.is_rate_limited().await, "cooldown should be active right after marking");

        // Simulate the cooldown having already expired.
        *client.rate_limited_until.lock().await = Some(Instant::now() - Duration::from_secs(1));
        assert!(!client.is_rate_limited().await, "expired cooldown should read as not rate-limited");
        assert!(
            client.rate_limited_until.lock().await.is_none(),
            "expired cooldown should be cleared, not left as a stale Some"
        );
    }
}
