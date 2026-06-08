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

#[derive(Deserialize, Clone, Debug)]
pub struct SpotifyTrack {
    pub id: String,
    pub name: String,
    pub artists: Vec<SpotifyArtist>,
    pub popularity: u32,
}

impl SpotifyTrack {
    pub fn artist_name(&self) -> &str {
        self.artists.first().map(|a| a.name.as_str()).unwrap_or("")
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct SpotifyArtist {
    pub name: String,
}

/// Returned by `lookup_track` — everything the frontend needs for preview + open-in-spotify.
#[derive(serde::Serialize, Debug)]
pub struct SpotifyTrackPreview {
    pub id: String,
    pub preview_url: Option<String>,
    pub spotify_url: String,
}

const API_BASE: &str = "https://api.spotify.com/v1";

impl SpotifyClient {
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

    /// Search for a track by artist + name. Returns the Spotify track ID or None.
    pub async fn search_track(&self, artist: &str, track: &str) -> Option<String> {
        let token = self.get_token().await.ok()?;
        let query = format!("track:\"{}\" artist:\"{}\"", track, artist);

        #[derive(Deserialize)]
        struct Resp { tracks: Items }
        #[derive(Deserialize)]
        struct Items { items: Vec<SpotifyTrack> }

        let resp = self.client
            .get(format!("{}/search", API_BASE))
            .bearer_auth(&token)
            .query(&[("q", query.as_str()), ("type", "track"), ("limit", "1")])
            .send()
            .await
            .ok()?;

        resp.json::<Resp>().await.ok()?
            .tracks.items.into_iter().next()
            .map(|t| t.id)
    }

    /// Get recommended tracks for up to 5 seed track IDs.
    /// max_popularity caps how mainstream results can be (0–100).
    pub async fn get_recommendations(
        &self,
        seed_ids: &[String],
        limit: u32,
        max_popularity: u32,
    ) -> Vec<SpotifyTrack> {
        let token = match self.get_token().await {
            Ok(t) => t,
            Err(e) => { eprintln!("Spotify token error: {}", e); return vec![]; }
        };

        #[derive(Deserialize)]
        struct Resp { tracks: Vec<SpotifyTrack> }

        let seeds = seed_ids.join(",");
        let limit_str = limit.to_string();
        let pop_str = max_popularity.to_string();

        let resp = self.client
            .get(format!("{}/recommendations", API_BASE))
            .bearer_auth(&token)
            .query(&[
                ("seed_tracks", seeds.as_str()),
                ("limit", limit_str.as_str()),
                ("max_popularity", pop_str.as_str()),
            ])
            .send()
            .await;

        match resp {
            Ok(r) => r.json::<Resp>().await.map(|r| r.tracks).unwrap_or_default(),
            Err(e) => { eprintln!("Spotify recommendations error: {}", e); vec![] }
        }
    }
}
