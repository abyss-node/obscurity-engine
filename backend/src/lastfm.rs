use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use dashmap::DashMap;
use std::time::{Duration, Instant};
use serde_json::Value;
use crate::models::SimilarArtist;

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

const LASTFM_API_URL: &str = "http://ws.audioscrobbler.com/2.0/";

pub struct LastfmClient {
    pub client: Client,
    pub api_key: String,
    pub audit_cache: DashMap<String, (Instant, crate::models::ArtistInfoResponse)>,
}

impl LastfmClient {
    pub fn new(api_key: String) -> Self {
        Self {
            client: Client::new(),
            api_key,
            audit_cache: DashMap::new(),
        }
    }

    pub async fn fetch_user_top_artists(
        &self,
        username: &str,
        limit: u32,
        period: TimePeriod,
    ) -> Result<TopArtistsResponse, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!(
            "{}?method=user.gettopartists&user={}&api_key={}&period={}&format=json&limit={}",
            LASTFM_API_URL, urlencoding::encode(username), self.api_key, period, limit
        );
        let resp_text = self.client.get(&url).send().await?.error_for_status()?.text().await?;
        
        let json: Value = serde_json::from_str(&resp_text)?;
        if let Some(err) = json.get("error") {
            let err_msg: LastfmErrorResponse = serde_json::from_value(json)?;
            return Err(format!("Last.fm Error {}: {}", err_msg.error, err_msg.message).into());
        }

        let response: TopArtistsResponse = serde_json::from_str(&resp_text)?;
        Ok(response)
    }

    pub async fn fetch_similar_artists(
        &self,
        artist_name: &str,
        limit: u32,
    ) -> Result<SimilarArtistsResponse, reqwest::Error> {
        let url = format!(
            "{}?method=artist.getsimilar&artist={}&api_key={}&format=json&limit={}",
            LASTFM_API_URL, urlencoding::encode(artist_name), self.api_key, limit
        );
        let response = self.client.get(&url).send().await?.error_for_status()?.json().await?;
        Ok(response)
    }

    pub async fn fetch_recent_tracks(
        &self,
        username: &str,
        limit: u32,
        page: u32,
        from_ts: Option<u64>,
    ) -> Result<crate::models::RecentTracksResponse, Box<dyn std::error::Error + Send + Sync>> {
        let from_param = from_ts
            .map(|ts| format!("&from={}", ts))
            .unwrap_or_default();
        let url = format!(
            "{}?method=user.getrecenttracks&user={}&api_key={}&limit={}&page={}&extended=1&format=json{}",
            LASTFM_API_URL, urlencoding::encode(username), self.api_key, limit, page, from_param
        );
        let resp_text = self.client.get(&url).send().await?.error_for_status()?.text().await?;
        
        let json: Value = serde_json::from_str(&resp_text)?;
        if let Some(error_node) = json.get("error") {
             // Handle both structured error and simple error fields
             let msg = json.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown Last.fm error");
             let code = error_node.as_u64().unwrap_or(0);
             return Err(format!("Last.fm Error {}: {}", code, msg).into());
        }

        let response: crate::models::RecentTracksResponse = serde_json::from_str(&resp_text)?;
        Ok(response)
    }

    pub async fn fetch_artist_info(
        &self,
        artist_name: &str,
        username: &str,
    ) -> Result<crate::models::ArtistInfoResponse, reqwest::Error> {
        let cache_key = format!("{}:{}", artist_name, username);
        
        // 24-hour TTL Cache lookup
        if let Some(entry) = self.audit_cache.get(&cache_key) {
            if entry.0.elapsed() < Duration::from_secs(86400) {
                return Ok(entry.1.clone());
            }
        }

        let url = format!(
            "{}?method=artist.getinfo&artist={}&username={}&api_key={}&format=json",
            LASTFM_API_URL, urlencoding::encode(artist_name), urlencoding::encode(username), self.api_key
        );
        let response: crate::models::ArtistInfoResponse = self.client.get(&url).send().await?.error_for_status()?.json().await?;
        
        // A2: Cap the cache at 10,000 entries to prevent unbounded memory growth on long-running instances
        if self.audit_cache.len() >= 10_000 {
            if let Some(entry) = self.audit_cache.iter().next().map(|e| e.key().clone()) {
                self.audit_cache.remove(&entry);
            }
        }
        self.audit_cache.insert(cache_key, (Instant::now(), response.clone()));

        Ok(response)
    }

    /// Phase 5 (dual-graph): fetch top artists for a given genre tag
    pub async fn fetch_tag_top_artists(
        &self,
        tag: &str,
        limit: u32,
    ) -> Result<Vec<SimilarArtist>, Box<dyn std::error::Error + Send + Sync>> {
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
        let resp_text = self.client.get(&url).send().await?.error_for_status()?.text().await?;
        let response: TagTopArtistsResponse = serde_json::from_str(&resp_text)?;
        Ok(response.topartists.artist)
    }

    /// Fetches the top 10 artists across all 4 time periods, then in parallel fetches 20
    /// similar artists for each unique historical top artist.
    pub async fn fetch_all_periods_and_similar(
        self: Arc<Self>,
        username: String,
    ) -> Result<Vec<(TimePeriod, Artist, Vec<Artist>)>, Box<dyn std::error::Error + Send + Sync>> {
        let periods = vec![
            TimePeriod::SevenDay,
            TimePeriod::OneMonth,
            TimePeriod::TwelveMonth,
            TimePeriod::Overall,
        ];

        let mut period_futures = FuturesUnordered::new();

        // 1. Fan out for the 4 temporal periods concurrently
        for period in periods {
            let client_clone = Arc::clone(&self);
            let uname = username.clone();

            period_futures.push(tokio::spawn(async move {
                // Fetch top 10 artists for this period
                let top_res = client_clone.fetch_user_top_artists(&uname, 10, period).await?;
                
                let mut similar_futures = FuturesUnordered::new();
                
                // 2. Sub-Fan out: For each top artist, fetch 20 Similar Artists concurrently
                for artist in top_res.topartists.artist {
                    let sub_client = Arc::clone(&client_clone);
                    let a_name = artist.name.clone();
                    
                    similar_futures.push(tokio::spawn(async move {
                        let sim_res = sub_client.fetch_similar_artists(&a_name, 20).await;
                        (artist, sim_res)
                    }));
                }
                
                // Collect internal results
                let mut period_results = Vec::new();
                while let Some(res) = similar_futures.next().await {
                    if let Ok((artist, Ok(sim_res))) = res {
                        period_results.push((period, artist, sim_res.similarartists.artist));
                    }
                }
                
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(period_results)
            }));
        }

        // Gather all 4 period results
        let mut all_results = Vec::new();
        while let Some(res) = period_futures.next().await {
            if let Ok(Ok(period_data)) = res {
                all_results.extend(period_data);
            }
        }

        Ok(all_results)
    }
}
