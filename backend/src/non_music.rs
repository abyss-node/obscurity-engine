// "Is this music?" filter for recommendation candidates. Last.fm accepts any
// scrobbled string as an artist, so podcasts, talks and YouTube channels show up
// as artists with real listener counts and pass the listener ceiling and the
// never-played check. The data is plain lists so a new case is a one-line
// addition.
//
// Principle: when in doubt, keep. Missing a podcast is a cosmetic miss; hiding
// an obscure musician is the product failing. Real sub-ceiling musicians carry
// "spoken word", "speech", "talk", "sound effects" and "white noise" tags
// (hip-hop acts, post-rock, harsh noise), so those are AMBIGUOUS and never drop
// an artist on their own.
//
// Rule (see `is_non_music`), over the first 5 tags in Last.fm order:
//   1. Name: the normalized name is in NON_MUSIC_NAMES -> drop. Tags are
//      unreliable for channels (T-Series is tagged [techno, Rave]).
//   2. STRONG tags (podcast, audiobook, lecture, sermon, stand up, ...) in the
//      top 3 mark a candidate. AMBIGUOUS tags (spoken word, speech, talk, news,
//      interview, white noise, sound effects, comedy) in the top 3 mark one only
//      when a STRONG tag also appears in the top 5.
//   3. Music-genre override: a candidate is kept when its STRONG tag is not the
//      #1 tag and one of the top 3 tags is a music genre. "podcast" first is
//      a podcast ([podcast, emo, screamo] is Serial); "podcast" behind a genre
//      is a musician or a band's side project. Critical Role
//      ([dungeons and dragons, podcast, live, ...]) has no genre in its top 3,
//      so it is still dropped.
// Accepted misses: spoken-word-only talk channels with no STRONG tag
// (RealLifeLore is handled by name). Tracks mode is not filtered; it is
// UI-gated and has no artist-info tags at this stage.

use crate::utils::normalize_artist_name;

/// Unambiguous non-music content types. Compared after `normalize_tag`.
pub const STRONG_TAGS: &[&str] = &[
    "podcast", "podcasts", "audiobook", "audiobooks", "lecture", "lectures",
    "sermon", "sermons", "talk show", "talk radio", "radio show",
    "audio drama", "stand up", "stand up comedy", "asmr",
];

/// Common on real musicians too; only count next to a STRONG tag.
pub const AMBIGUOUS_TAGS: &[&str] = &[
    "spoken word", "speech", "talk", "news", "interview", "interviews",
    "white noise", "sound effects", "comedy",
];

/// Whole-tag music genres for the override. Compared after `normalize_tag`.
pub const MUSIC_GENRE_TAGS: &[&str] = &[
    "hip hop", "hiphop", "rap", "rock", "punk", "metal", "jazz", "funk", "soul",
    "folk", "electronic", "electronica", "ambient", "noise", "drone", "emo",
    "hardcore", "indie", "pop", "experimental", "blues", "country", "reggae",
    "techno", "house", "trance", "dubstep", "classical", "rnb", "r&b",
    "alternative", "shoegaze", "screamo", "grunge", "psychedelic", "post rock",
    "dub", "ska", "gospel", "latin", "lo fi", "synthpop", "darkwave", "ebm",
    "industrial", "idm", "grindcore", "singer songwriter", "avant garde",
    "neo soul", "harsh noise", "power electronics", "math rock", "post punk",
];

/// Last word of a compound genre tag ("noise rock", "underground hip hop",
/// "synth pop", "post hardcore", "new wave").
pub const MUSIC_GENRE_SUFFIXES: &[&str] = &[
    "rock", "metal", "punk", "hop", "jazz", "folk", "core", "wave", "pop",
    "soul", "funk", "blues", "rap", "electronic", "ambient", "noise", "drone",
    "house", "techno", "trance",
];

/// Labels, channels and talk channels that scrobble as artists. Matched by name
/// because their tags are unreliable or absent. Compared after `name_key`.
/// Bare "Saregama" and "YRF" are deliberately absent: both collide with real
/// acts (SaReGaMa is a chillout artist).
pub const NON_MUSIC_NAMES: &[&str] = &[
    "T-Series", "Zee Music Company", "Saregama Music",
    "Tips Official", "Tips Music", "Sony Music India", "Speed Records",
    "Shemaroo", "Eros Now Music", "Times Music",
    "Lahari Music", "Aditya Music", "Think Music India", "White Hill Music",
    "Desi Music Factory", "Geet MP3", "Bollywood Classics",
    // Talk channels whose tags carry no STRONG marker.
    "Sounds of Isha", "RealLifeLore",
];

pub const TAG_WINDOW: usize = 3;
pub const DECISIVE_WINDOW: usize = 5;

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

fn is_music_genre(tag: &str) -> bool {
    MUSIC_GENRE_TAGS.contains(&tag)
        || tag.rsplit(' ').next().is_some_and(|last| MUSIC_GENRE_SUFFIXES.contains(&last))
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
    let Some(strong_pos) = norm.iter().position(|t| STRONG_TAGS.contains(&t.as_str())) else {
        return false;
    };
    let lead = &norm[..norm.len().min(TAG_WINDOW)];
    let candidate = strong_pos < TAG_WINDOW
        || lead.iter().any(|t| AMBIGUOUS_TAGS.contains(&t.as_str()));
    if !candidate {
        return false;
    }
    // A STRONG tag first is decisive; behind a genre it is a musician.
    let genre_override = strong_pos > 0 && lead.iter().any(|t| is_music_genre(t));
    !genre_override
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_TAGS: &[&str] = &[];

    // Real Last.fm tag lists (artist.getinfo), captured 2026-10-16.
    #[test]
    fn real_podcasts_and_comics_are_dropped() {
        assert!(is_non_music("Giant Bomb", &["podcast", "video games", "comedy", "jeff gerstmann", "Brad Shoemaker"]));
        assert!(is_non_music("IGN Staff", &["podcast", "video games", "Movies", "entertainment", "IGN"]));
        assert!(is_non_music("Geekbox.net and the Comedy Button Cast", &["podcast", "comedy", "Gamespy Debriefings", "Scott Bromley", "Comedy Button"]));
        assert!(is_non_music("Joe Rogan Experience", &["podcast"]));
        assert!(is_non_music("Lex Fridman Podcast", &["science", "podcast"]));
        assert!(is_non_music("Critical Role", &["dungeons and dragons", "podcast", "live", "comedy", "gaming"]));
        assert!(is_non_music("Serial", &["podcast", "emo", "chile", "screamo", "Scramz"]));
        assert!(is_non_music("George Carlin", &["comedy", "stand-up", "stand-up comedy", "spoken word", "humor"]));
        assert!(is_non_music("Bill Hicks", &["comedy", "stand-up", "genius", "spoken word", "stand-up comedy"]));
    }

    #[test]
    fn names_are_dropped_despite_music_or_missing_tags() {
        assert!(is_non_music("Sounds of Isha", &["misc", "All", "nugget", "Hindu", "speech"]));
        assert!(is_non_music("RealLifeLore", &["spoken word", "american", "science", "geography", "factual"]));
        assert!(is_non_music("T-Series", &["techno", "Rave"]));
        assert!(is_non_music("t series", NO_TAGS));
        assert!(is_non_music("T\u{2010}Series", NO_TAGS));
        assert!(is_non_music("TSERIES", NO_TAGS));
        assert!(is_non_music("Zee Music Company", NO_TAGS));
        assert!(is_non_music("Saregama Music", NO_TAGS));
    }

    #[test]
    fn real_musicians_with_ambiguous_tags_are_kept() {
        assert!(!is_non_music("Speech", &["Hip-Hop", "soul", "rap", "hip hop", "speech"]));
        assert!(!is_non_music("Sound FX", &["sound effects", "Canadian", "Hip-Hop", "hip hop", "underground hip hop"]));
        assert!(!is_non_music("Enablers", &["post-rock", "spoken word", "noise rock", "indie", "math rock"]));
        assert!(!is_non_music("Lightnin' Rod", &["funk", "spoken word", "jazz", "rap", "70s"]));
        assert!(!is_non_music("The Floacist", &["soul", "Neo-Soul", "spoken word", "rnb", "r&b"]));
        assert!(!is_non_music("Laurie Anderson", &["experimental", "Avant-Garde", "electronic", "spoken word", "female vocalists"]));
        assert!(!is_non_music("Invisible Path", &["drone", "ambient", "white noise", "noise"]));
        assert!(!is_non_music("ARABIAN VULVA", &["power electronics", "harsh noise", "white noise"]));
        assert!(!is_non_music("Spell Talk", &["Psychedelic Rock", "Lo-Fi", "talk", "psych", "candy rock"]));
        assert!(!is_non_music("SaReGaMa", &["chillout", "electronic", "world", "ambient", "instrumental"]));
        assert!(!is_non_music("Weird Al", &["comedy", "parody", "pop"]));
        assert!(!is_non_music("Tenacious D", &["rock", "comedy", "hard rock", "alternative rock", "alternative"]));
    }

    #[test]
    fn podcast_behind_a_genre_is_a_musician() {
        assert!(!is_non_music("Some Band", &["black metal", "metal", "podcast"]));
        assert!(!is_non_music("Some Band", &["black metal", "atmospheric black metal", "norwegian", "metal", "dark", "podcast"]));
        assert!(is_non_music("Talky", &["podcast", "metal", "rock"]));
    }

    #[test]
    fn ambiguous_alone_is_never_enough_and_variants_match() {
        assert!(!is_non_music("A", &["spoken word"]));
        assert!(!is_non_music("A", &["speech", "talk", "news"]));
        assert!(is_non_music("A", &["Stand-Up"]));
        assert!(is_non_music("A", &["Audio_Drama"]));
        assert!(is_non_music("A", &["  PODCAST "]));
    }

    #[test]
    fn ordinary_artists_are_kept() {
        assert!(!is_non_music("Radiohead", &["alternative", "rock", "electronic"]));
        assert!(!is_non_music("Radiohead", NO_TAGS));
        assert!(!is_non_music("", NO_TAGS));
    }
}
