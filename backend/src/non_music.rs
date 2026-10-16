// "Is this music?" filter for recommendation candidates. Last.fm accepts any
// scrobbled string as an artist, so podcasts, spoken-word talks and YouTube
// channels show up as artists with real listener counts and pass the listener
// ceiling and the never-played check. The data is plain lists so a new case is
// a one-line addition.
//
// Rule (see `is_non_music`):
//   1. Any of the artist's top 3 tags (Last.fm order) is in NON_MUSIC_TAGS.
//   2. "speech" and "spoken word" are decisive anywhere in the top 5, because
//      spiritual-talk channels carry them behind generic tags
//      (Sounds of Isha: [misc, All, nugget, Hindu, speech]).
//   3. COMEDY_TAGS in the top 3 count only when another non-music tag is also
//      present in the top 5, so musical-comedy acts ([comedy, parody, pop])
//      survive.
//   4. The normalized name is in NON_MUSIC_NAMES.
// Only the leading tags are inspected so a stray low-ranked tag cannot remove a
// real musician.

use crate::utils::normalize_artist_name;

/// Content types that are not music. Compared after `normalize_tag`.
pub const NON_MUSIC_TAGS: &[&str] = &[
    "podcast", "podcasts", "audiobook", "audiobooks", "spoken word", "speech",
    "asmr", "news", "talk", "talk show", "talk radio", "lecture", "lectures",
    "sermon", "sermons", "radio show", "white noise", "sound effects",
    "interview", "interviews", "audio drama", "stand up",
];

/// Ambiguous on their own (musical comedy is music), so they only count next to
/// another NON_MUSIC tag.
pub const COMEDY_TAGS: &[&str] = &["comedy", "stand up comedy"];

/// Tags decisive anywhere in the top DECISIVE_WINDOW rather than top TAG_WINDOW.
pub const DECISIVE_ANYWHERE_TAGS: &[&str] = &["speech", "spoken word"];

pub const TAG_WINDOW: usize = 3;
pub const DECISIVE_WINDOW: usize = 5;

/// Record labels and YouTube channels that scrobble as artists. Their tags are
/// unreliable (T-Series is tagged [techno, Rave]), so they are matched by name.
/// Compared after `name_key`.
pub const NON_MUSIC_NAMES: &[&str] = &[
    "T-Series", "Zee Music Company", "Saregama", "Saregama Music",
    "Tips Official", "Tips Music", "Sony Music India", "Speed Records",
    "Shemaroo", "Eros Now Music", "YRF", "Times Music",
    "Lahari Music", "Aditya Music", "Think Music India", "White Hill Music",
    "Desi Music Factory", "Geet MP3", "Bollywood Classics",
];

/// Lowercase, trim, and treat hyphens/underscores as spaces so "spoken-word",
/// "Spoken Word" and "stand-up" compare equal to their list entries.
fn normalize_tag(tag: &str) -> String {
    tag.to_lowercase()
        .replace(['-', '_', '\u{2010}', '\u{2011}'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Normalized name with all whitespace removed, so "T-Series", "t series" and
/// "T\u{2010}Series" share one key.
fn name_key(name: &str) -> String {
    normalize_artist_name(name).replace(' ', "")
}

fn is_non_music_name(name: &str) -> bool {
    let key = name_key(name);
    !key.is_empty() && NON_MUSIC_NAMES.iter().any(|n| name_key(n) == key)
}

/// True when the artist should never be recommended. `tags` are in Last.fm order.
pub fn is_non_music<S: AsRef<str>>(name: &str, tags: &[S]) -> bool {
    if is_non_music_name(name) {
        return true;
    }
    let norm: Vec<String> = tags
        .iter()
        .take(DECISIVE_WINDOW)
        .map(|t| normalize_tag(t.as_ref()))
        .collect();
    let lead_hit = norm.iter().take(TAG_WINDOW).any(|t| NON_MUSIC_TAGS.contains(&t.as_str()));
    let decisive_hit = norm.iter().any(|t| DECISIVE_ANYWHERE_TAGS.contains(&t.as_str()));
    if lead_hit || decisive_hit {
        return true;
    }
    let comedy_lead = norm.iter().take(TAG_WINDOW).any(|t| COMEDY_TAGS.contains(&t.as_str()));
    comedy_lead && norm.iter().any(|t| NON_MUSIC_TAGS.contains(&t.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_TAGS: &[&str] = &[];

    #[test]
    fn giant_bomb_podcast_is_dropped() {
        assert!(is_non_music("Giant Bomb", &["podcast", "video games", "comedy", "gaming", "news"]));
    }

    #[test]
    fn sounds_of_isha_speech_in_fifth_place_is_dropped() {
        assert!(is_non_music("Sounds of Isha", &["misc", "All", "nugget", "Hindu", "speech"]));
    }

    #[test]
    fn speech_beyond_top_five_is_not_decisive() {
        assert!(!is_non_music("X", &["rock", "indie", "pop", "folk", "alt", "speech"]));
    }

    #[test]
    fn musical_comedy_survives() {
        assert!(!is_non_music("Weird Al", &["comedy", "parody", "pop"]));
        assert!(!is_non_music("Tenacious D", &["comedy", "rock", "hard rock", "funny", "parody"]));
    }

    #[test]
    fn comedy_with_another_non_music_tag_is_dropped() {
        assert!(is_non_music("Some Comic", &["stand-up comedy", "comedy", "stand-up"]));
        assert!(is_non_music("Other", &["comedy", "funny", "humor", "satire", "podcast"]));
    }

    #[test]
    fn stray_low_ranked_tag_does_not_kill_a_band() {
        let tags = ["black metal", "atmospheric black metal", "norwegian", "metal", "dark", "podcast"];
        assert!(!is_non_music("Some Band", &tags));
        assert!(!is_non_music("Some Band", &["black metal", "metal", "norwegian", "podcast"]));
    }

    #[test]
    fn tag_variants_match() {
        assert!(is_non_music("A", &["Spoken-Word"]));
        assert!(is_non_music("A", &["  SPOKEN WORD "]));
        assert!(is_non_music("A", &["Stand-Up"]));
        assert!(is_non_music("A", &["Audio_Drama"]));
    }

    #[test]
    fn label_names_are_dropped_despite_music_tags() {
        assert!(is_non_music("T-Series", &["techno", "Rave"]));
        assert!(is_non_music("T-Series", NO_TAGS));
        assert!(is_non_music("t series", NO_TAGS));
        assert!(is_non_music("T\u{2010}Series", NO_TAGS));
        assert!(is_non_music("TSERIES", NO_TAGS));
        assert!(is_non_music("Zee Music Company", NO_TAGS));
    }

    #[test]
    fn ordinary_artists_are_kept() {
        assert!(!is_non_music("Radiohead", &["alternative", "rock", "electronic"]));
        assert!(!is_non_music("Radiohead", NO_TAGS));
        assert!(!is_non_music("", NO_TAGS));
    }
}
