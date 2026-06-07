/// Phase 1.5: dual-graph cross-validation via genre tags.
///
/// Derives the user's top genre tags from their seed artists, then fetches
/// top artists for those tags from Last.fm's tag graph. Any candidate that
/// appears in BOTH the similar-artist graph (Phase 2) AND here gets a
/// cross_validated bonus in scoring (Phase 3).
///
/// This second independent signal increases confidence in a recommendation:
/// if Last.fm's genre community and your personal similar-artist chain both
/// point at the same artist, it's a stronger match than either alone.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use crate::lastfm::LastfmClient;
use crate::utils::normalize_artist_name;
use super::seeds::Seeds;

const SEED_INFO_CONCURRENCY: usize = 5;
const TOP_SEEDS_FOR_TAGS: usize = 15;
const TAGS_TO_DERIVE: usize = 3;
const TAG_ARTISTS_LIMIT: u32 = 100;

pub async fn fetch(
    client: &Arc<LastfmClient>,
    username: &str,
    seeds: &Seeds,
) -> HashSet<String> {
    let genre_tags = derive_genre_tags(client, username, seeds).await;
    println!("TAG_GRAPH: derived genre tags: {:?}", genre_tags);

    let candidates = fetch_tag_artists(client, genre_tags).await;
    println!("TAG_GRAPH: {} candidates ready for cross-validation", candidates.len());
    candidates
}

/// Fetches artist info for the top seeds and tallies their genre tags by frequency.
async fn derive_genre_tags(
    client: &Arc<LastfmClient>,
    username: &str,
    seeds: &Seeds,
) -> Vec<String> {
    let mut weighted_seeds: Vec<(&String, f64)> = seeds.weights.iter()
        .map(|(name, &weight)| (name, weight))
        .collect();
    weighted_seeds.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    weighted_seeds.truncate(TOP_SEEDS_FOR_TAGS);

    let semaphore = Arc::new(Semaphore::new(SEED_INFO_CONCURRENCY));
    let mut info_futures = FuturesUnordered::new();
    for (name, _) in &weighted_seeds {
        let client = Arc::clone(client);
        let name = (*name).clone();
        let username = username.to_string();
        let semaphore = Arc::clone(&semaphore);
        info_futures.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await;
            client.fetch_artist_info(&name, &username).await
        }));
    }

    let mut tag_freq: HashMap<String, usize> = HashMap::new();
    while let Some(result) = info_futures.next().await {
        if let Ok(Ok(info)) = result {
            if let Some(tags) = info.artist.tags {
                for tag in tags.tag.iter().take(3) {
                    *tag_freq.entry(tag.name.to_lowercase()).or_insert(0) += 1;
                }
            }
        }
    }

    let mut tag_freq_vec: Vec<(String, usize)> = tag_freq.into_iter().collect();
    tag_freq_vec.sort_by(|a, b| b.1.cmp(&a.1));
    tag_freq_vec.into_iter().take(TAGS_TO_DERIVE).map(|(tag, _)| tag).collect()
}

/// Fetches top artists for each derived genre tag concurrently.
async fn fetch_tag_artists(
    client: &Arc<LastfmClient>,
    genre_tags: Vec<String>,
) -> HashSet<String> {
    let mut tag_futures = FuturesUnordered::new();
    for tag in genre_tags {
        let client = Arc::clone(client);
        tag_futures.push(tokio::spawn(async move {
            client.fetch_tag_top_artists(&tag, TAG_ARTISTS_LIMIT).await
        }));
    }

    let mut candidates = HashSet::new();
    while let Some(result) = tag_futures.next().await {
        if let Ok(Ok(artists)) = result {
            for artist in artists {
                candidates.insert(normalize_artist_name(&artist.name));
            }
        }
    }
    candidates
}
