use crate::lastfm::TimePeriod;

/// Normalise an artist name to a stable key for deduplication.
/// Lowercases, strips leading "the ", removes non-alphanumeric characters,
/// and collapses whitespace — so "The Cure" and "cure" map to the same key.
pub fn normalize_artist_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let s = lower.strip_prefix("the ").unwrap_or(&lower);
    s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_period(period_str: &str) -> TimePeriod {
    match period_str {
        "7day"    => TimePeriod::SevenDay,
        "1month"  => TimePeriod::OneMonth,
        "3month"  => TimePeriod::ThreeMonth,
        "6month"  => TimePeriod::SixMonth,
        "12month" => TimePeriod::TwelveMonth,
        _         => TimePeriod::Overall,
    }
}
