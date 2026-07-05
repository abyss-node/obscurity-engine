use reqwest::Client;
use serde::Deserialize;
use tokio::sync::Mutex;
use std::time::{Duration, Instant};

pub struct SpotifyClient {
    client: Client,
    client_id: String,
    client_secret: String,
    token: Mutex<Option<(String, Instant)>>,
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
#[derive(serde::Serialize, Debug, Default, Clone)]
pub struct ArtistLinks {
    pub spotify_url: Option<String>,
    pub this_is_url: Option<String>,
    pub bandcamp_url: Option<String>,
}

impl SpotifyClient {
    /// Resolve Spotify listen/find links for an artist. Best-effort: a failed
    /// lookup leaves that field None. Both sub-lookups run concurrently.
    /// (Bandcamp is resolved client-side as a search link — its public API
    /// 403s datacenter IPs, so there's no point calling it from the server.)
    pub async fn resolve_artist_links(&self, artist: &str) -> ArtistLinks {
        let Ok(token) = self.get_token().await else {
            return ArtistLinks::default();
        };
        let (spotify_url, this_is_url) = futures::join!(
            self.search_artist_url(&token, artist),
            self.search_this_is(&token, artist),
        );
        ArtistLinks { spotify_url, this_is_url, bandcamp_url: None }
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
        let data: Resp = parse_spotify_response(resp, &format!("search_artist_url '{artist}'")).await?;
        // Prefer an exact (case-insensitive) name match; fall back to the top hit.
        let items = data.artists.items;
        items.iter()
            .find(|a| a.name.eq_ignore_ascii_case(artist))
            .or_else(|| items.first())
            .map(|a| a.external_urls.spotify.clone())
    }

    /// Spotify's official "This Is {artist}" playlist, if one exists. We only
    /// accept a playlist owned by `spotify` whose name matches, so we never
    /// surface a random user playlist.
    async fn search_this_is(&self, token: &str, artist: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Resp { playlists: Items }
        #[derive(Deserialize)]
        struct Items { items: Vec<Option<Playlist>> }
        #[derive(Deserialize)]
        struct Playlist { name: String, owner: Owner, external_urls: ExternalUrls }
        #[derive(Deserialize)]
        struct Owner { id: String }
        #[derive(Deserialize)]
        struct ExternalUrls { spotify: String }

        let want = format!("This Is {}", artist);
        let resp = match self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(token)
            .query(&[("q", want.as_str()), ("type", "playlist"), ("limit", "5")])
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("Spotify search_this_is request failed for '{artist}': {e}");
                return None;
            }
        };
        let data: Resp = parse_spotify_response(resp, &format!("search_this_is '{artist}'")).await?;
        // Spotify's playlist search can return null array entries — filter them.
        data.playlists.items.into_iter()
            .flatten()
            .find(|p| p.owner.id == "spotify" && p.name.eq_ignore_ascii_case(&want))
            .map(|p| p.external_urls.spotify)
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
