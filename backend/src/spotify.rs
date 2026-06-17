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

        let resp = self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(token)
            .query(&[("q", artist), ("type", "artist"), ("limit", "3")])
            .send()
            .await.ok()?;
        let data = resp.json::<Resp>().await.ok()?;
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
        let resp = self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(token)
            .query(&[("q", want.as_str()), ("type", "playlist"), ("limit", "5")])
            .send()
            .await.ok()?;
        let data = resp.json::<Resp>().await.ok()?;
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

        let resp = self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(&token)
            .query(&[("q", query.as_str()), ("type", "track"), ("limit", "1")])
            .send()
            .await.ok()?;

        let data = resp.json::<Resp>().await.ok()?;
        let t = data.tracks.items.into_iter().next()?;
        Some(SpotifyTrackPreview { id: t.id, preview_url: t.preview_url, spotify_url: t.external_urls.spotify })
    }

    pub fn new(client_id: String, client_secret: String) -> Self {
        Self {
            client: Client::new(),
            client_id,
            client_secret,
            token: Mutex::new(None),
        }
    }

    async fn get_token(&self) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut cache = self.token.lock().await;
        if let Some((token, obtained_at)) = cache.as_ref() {
            if obtained_at.elapsed() < Duration::from_secs(3500) {
                return Ok(token.clone());
            }
        }
        let resp = self.client
            .post("https://accounts.spotify.com/api/token")
            .basic_auth(&self.client_id, Some(&self.client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await?
            .error_for_status()?;
        let data: TokenResponse = resp.json().await?;
        *cache = Some((data.access_token.clone(), Instant::now()));
        Ok(data.access_token)
    }

}
