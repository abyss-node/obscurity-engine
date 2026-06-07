use serde::{Deserialize, Deserializer, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DiscoveryResponse {
    pub artists: Vec<DiscoveryResponseItem>,
    pub top_genres: Vec<GenreWeight>,
    pub deepest_date: Option<String>,
    #[serde(default)]
    pub active_seed_count: usize,
    #[serde(default)]
    pub depth_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ErrorResponse {
    pub error: String,
    pub code: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GenreWeight {
    pub name: String,
    pub weight: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SourceSeed {
    pub name: String,
    pub percentile: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DiscoveryResponseItem {
    pub name: String,
    pub stickiness_score: f64,
    pub conviction_score: usize,
    pub composite_score: f64,
    pub total_listeners: u64,
    pub top_tags: Vec<String>,
    pub source_seeds: Vec<SourceSeed>,
    #[serde(default)]
    pub cross_validated: bool,
    #[serde(default)]
    pub taste_alignment: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub velocity: Option<f64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ArtistInfoResponse {
    pub artist: Artist,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Artist {
    pub name: String,
    pub stats: Stats,
    #[serde(default)]
    pub tags: Option<Tags>,
    #[serde(default)]
    pub stickiness_score: Option<f64>,
    #[serde(default)]
    pub recommended_by: Vec<String>,
    #[serde(default)]
    pub conviction_score: Option<usize>,
}

impl Artist {
    pub fn calculate_stickiness(&mut self) {
        if self.stats.listeners > 0 {
            self.stickiness_score = Some(self.stats.playcount as f64 / self.stats.listeners as f64);
        } else {
            self.stickiness_score = Some(0.0);
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Tags {
    #[serde(default)]
    pub tag: Vec<Tag>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Tag {
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Stats {
    #[serde(deserialize_with = "deserialize_u64")]
    pub listeners: u64,
    #[serde(deserialize_with = "deserialize_u64")]
    pub playcount: u64,
    pub userplaycount: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SimilarArtist {
    pub name: String,
    pub url: String,
}

/// Parses Last.fm's string-encoded counts into u64 during deserialization
fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(n) => n.as_u64().ok_or_else(|| D::Error::custom("Invalid u64")),
        serde_json::Value::String(s) => s.parse::<u64>().map_err(D::Error::custom),
        _ => Err(D::Error::custom("Expected number or string")),
    }
}
