-- MusicBrainz alias names for the alias-split veto (artist_meta.aliases).
--
-- Additive-only. NULL means aliases were never fetched for the row (every row
-- written before this migration, or a lookup that failed transiently); an empty
-- array means fetched and none. The application re-queues NULL-alias rows that
-- carry an mbid, so they fill in through the existing background worker.
ALTER TABLE artist_meta ADD COLUMN IF NOT EXISTS aliases TEXT[];
