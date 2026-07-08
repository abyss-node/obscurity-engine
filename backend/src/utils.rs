use crate::lastfm::TimePeriod;

/// Normalise an artist name to a stable key for deduplication.
/// Lowercases, strips leading "the ", removes non-alphanumeric characters,
/// and collapses whitespace — so "The Cure" and "cure" map to the same key.
pub fn normalize_artist_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    // Normalize "&" → "and" before stripping punctuation so "Zeal & Ardor"
    // and "Zeal and Ardor" collapse to the same key.
    let lower = lower.replace('&', "and");
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

/// Jan 1 00:00:00 UTC of the current year → now, as unix timestamps. Used for
/// the "ytd" period, which fetches an aggregated chart via
/// `user.getweeklyartistchart`'s arbitrary from/to range rather than one of
/// Last.fm's native period buckets.
pub fn ytd_range() -> (i64, i64) {
    use chrono::{Datelike, TimeZone, Utc};
    let now = Utc::now();
    let jan1 = Utc.with_ymd_and_hms(now.year(), 1, 1, 0, 0, 0).single()
        .unwrap_or(now);
    (jan1.timestamp(), now.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytd_range_spans_jan1_to_now() {
        use chrono::{Datelike, TimeZone, Timelike, Utc};

        let (from, to) = ytd_range();
        assert!(from < to, "from must be before to");

        let jan1 = Utc.timestamp_opt(from, 0).single().expect("valid timestamp");
        assert_eq!(jan1.month(), 1);
        assert_eq!(jan1.day(), 1);
        assert_eq!(jan1.hour(), 0);
        assert_eq!(jan1.minute(), 0);
        assert_eq!(jan1.second(), 0);

        let now = Utc::now().timestamp();
        assert!((now - to).abs() <= 5, "to should be within 5 seconds of now");
    }
}
