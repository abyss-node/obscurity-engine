// Country/region vocabulary ported 1:1 from frontend/src/lib/geoTags.ts
// (the `GEO_TAGS` set). Keep this list in sync with that file — it exists so
// the same whole-tag geo filter that already runs client-side for per-artist
// `top_tags` can also run server-side, once, on the aggregate `top_genres`
// readout (see FIX 2, 2026-07-05 resilience commit). Only exact, standalone
// tag matches are filtered — compound tags like "swedish death metal" are
// left alone, exactly like `isGeoTag` in geoTags.ts.
pub const GEO_TAGS: &[&str] = &[
    // Country adjectives (Last.fm's typical form)
    "american", "british", "german", "norwegian", "swedish", "finnish",
    "french", "japanese", "australian", "canadian", "danish", "dutch",
    "irish", "scottish", "polish", "italian", "russian", "icelandic",
    "ukrainian", "argentinian", "brazilian", "mexican", "spanish",
    "portuguese", "greek", "belgian", "swiss", "austrian", "hungarian",
    "czech", "romanian", "bulgarian", "serbian", "croatian", "turkish",
    "israeli", "chinese", "korean", "thai", "indonesian", "indian",
    "slovenian", "slovak", "latvian", "lithuanian", "estonian",
    "south african", "chilean", "colombian", "peruvian", "venezuelan",
    "welsh", "vietnamese", "filipino", "taiwanese",
    "singaporean", "malaysian", "pakistani", "bangladeshi", "nepali",
    "sri lankan",
    // Non-English country names that appear on Last.fm
    "brasil", "deutschland", "espana", "sverige", "suomi", "norge",
    "polska", "magyarorszag",
    // Country names
    "usa", "uk", "england", "germany", "norway", "sweden", "finland",
    "france", "japan", "australia", "canada", "denmark", "netherlands",
    "ireland", "scotland", "poland", "italy", "russia", "iceland",
    "ukraine", "argentina", "brazil", "mexico", "spain", "portugal",
    "greece", "belgium", "switzerland", "austria", "hungary", "czechia",
    "slovenia", "slovakia", "serbia", "croatia", "latvia", "lithuania", "estonia",
    "new zealand", "singapore", "taiwan", "bulgaria", "chile", "colombia",
    "peru", "venezuela", "wales", "vietnam", "philippines", "malaysia",
    "united kingdom", "united states", "india", "china", "korea",
    "south korea", "thailand", "turkey", "israel", "indonesia", "romania",
    "pakistan", "bangladesh", "nepal", "sri lanka",
    // Regions
    "scandinavian", "nordic", "european", "latin american", "north american",
    "eastern european", "middle eastern", "asian", "latin",
    // Geographically-defined scenes
    "nwobhm", "nyhc", "gothenburg", "bay area", "tampa", "seattle",
    "stockholm", "los angeles", "new york", "chicago", "manchester",
    "london", "birmingham",
];

/// Whole-tag, case-insensitive match — mirrors `isGeoTag` in
/// frontend/src/lib/geoTags.ts exactly (no token/substring matching, so
/// compound tags like "swedish death metal" never match here).
pub fn is_geo_tag(tag: &str) -> bool {
    let lowered = tag.to_lowercase();
    let trimmed = lowered.trim();
    GEO_TAGS.contains(&trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_tag_geo_matches_case_insensitive_and_trims() {
        assert!(is_geo_tag("india"));
        assert!(is_geo_tag("Indian"));
        assert!(is_geo_tag(" Brazil "));
        assert!(is_geo_tag("UNITED KINGDOM"));
        assert!(!is_geo_tag("death metal"));
    }

    #[test]
    fn compound_tags_are_not_geo_matches() {
        // Only standalone geo tags are dropped — a genre tag that merely
        // contains a country adjective must survive (parity with isGeoTag's
        // whole-string match, not a token match).
        assert!(!is_geo_tag("swedish death metal"));
        assert!(!is_geo_tag("bollywood"));
    }
}
