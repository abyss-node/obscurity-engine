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

/// Best-effort Bandcamp artist page via the public autocomplete endpoint
/// (unofficial, no key — works with any `reqwest::Client`, no Spotify creds
/// required). Only returns a URL on an exact band-name match so we don't link
/// to an unrelated page. Silently None on any failure.
pub async fn bandcamp_lookup(client: &Client, artist: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Resp { auto: Auto }
    #[derive(Deserialize)]
    struct Auto { results: Vec<Hit> }
    #[derive(Deserialize)]
    struct Hit {
        #[serde(rename = "type")]
        kind: Option<String>,
        name: Option<String>,
        // Band hits expose the artist page as `item_url_root`
        // (e.g. https://artist.bandcamp.com); the generic `url` is null.
        item_url_root: Option<String>,
    }

    let body = serde_json::json!({
        "search_text": artist,
        "search_filter": "b", // bands/artists only
        "full_page": false,
        "fan_id": null,
    });
    let resp = client
        .post("https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic")
        .json(&body)
        .send()
        .await.ok()?;
    let data = resp.json::<Resp>().await.ok()?;
    data.auto.results.into_iter()
        .find(|h| {
            h.kind.as_deref() == Some("b")
                && h.name.as_deref().map(|n| n.eq_ignore_ascii_case(artist)).unwrap_or(false)
        })
        .and_then(|h| h.item_url_root)
}

impl SpotifyClient {
    /// Resolve all listen/find links for an artist. Best-effort: any individual
    /// lookup that fails leaves that field None. The three sub-lookups run
    /// concurrently so the whole thing costs ~one round-trip, not three.
    pub async fn resolve_artist_links(&self, artist: &str) -> ArtistLinks {
        let token = match self.get_token().await {
            Ok(t) => t,
            // No Spotify token → we can still try Bandcamp (it needs no auth).
            Err(_) => {
                return ArtistLinks {
                    bandcamp_url: self.bandcamp_lookup(artist).await,
                    ..Default::default()
                };
            }
        };
        let (spotify_url, this_is_url, bandcamp_url) = futures::join!(
            self.search_artist_url(&token, artist),
            self.search_this_is(&token, artist),
            self.bandcamp_lookup(artist),
        );
        ArtistLinks { spotify_url, this_is_url, bandcamp_url }
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

    /// Best-effort Bandcamp lookup, delegating to the free function. Kept as a
    /// thin method so the credentialed resolve path reads uniformly.
    async fn bandcamp_lookup(&self, artist: &str) -> Option<String> {
        bandcamp_lookup(&self.client, artist).await
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
