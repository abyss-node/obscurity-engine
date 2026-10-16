-- Artist origin metadata from MusicBrainz (country, area, begin year, type).
--
-- Additive-only. Keyed by the same normalized name the pipeline dedups on
-- (utils::normalize_artist_name). A row whose metadata columns are all NULL is a
-- stored MISS (unresolvable artist); the application retries those after 30
-- days, so they never cost a MusicBrainz call per discovery. Rows with data are
-- permanent: an artist's country of origin does not change.
CREATE TABLE IF NOT EXISTS artist_meta (
    name_key     TEXT PRIMARY KEY,
    mbid         TEXT,
    country_iso2 TEXT,
    area_name    TEXT,
    begin_year   INTEGER,
    artist_type  TEXT,
    fetched_at   TIMESTAMPTZ NOT NULL
);
