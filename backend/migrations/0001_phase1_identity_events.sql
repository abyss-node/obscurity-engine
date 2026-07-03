-- Phase 1 — identity + events + observations (additive-only).
--
-- Additive-only rule: every future migration ADDs columns/tables/indexes; it
-- never drops or rewrites an existing one. Rollback = revert the binary, leave
-- the schema. All UUIDs are generated application-side (uuid v4) so no server
-- extension (pgcrypto/uuid-ossp) is required.

-- Users: synthetic UUID id (NOT the Last.fm username — usernames get renamed
-- and Spotify-only users arrive later). lastfm_username stored normalized
-- (lowercase) and unique, so a case-only rename resolves to the same row.
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY,
    lastfm_username TEXT UNIQUE NOT NULL,
    settings        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions: opaque 32-byte token, stored ONLY as its sha256 hash (constant-time
-- indexed lookup by hash; the raw token never touches the DB). 90-day expiry.
CREATE TABLE IF NOT EXISTS sessions (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Runs: one per fresh (non-cache-hit) discovery. user_id is NULL for anonymous
-- runs (typed-username, no session). username = the ANALYZED account.
CREATE TABLE IF NOT EXISTS runs (
    id                UUID PRIMARY KEY,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    username          TEXT NOT NULL,
    period            TEXT NOT NULL,
    appetite          TEXT NOT NULL,
    depth_score       DOUBLE PRECISION NOT NULL DEFAULT 0,
    active_seed_count INTEGER NOT NULL DEFAULT 0,
    top_genres        JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_user_idx ON runs(user_id);

-- Recommendations: capability-style UUIDv4 rec_id (unguessable), one per shown
-- or reserve (backfill) candidate in a run.
CREATE TABLE IF NOT EXISTS recommendations (
    rec_id           UUID PRIMARY KEY,
    run_id           UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    artist_name      TEXT NOT NULL,
    artist_name_norm TEXT NOT NULL,
    rank             INTEGER NOT NULL,
    conviction_score INTEGER NOT NULL DEFAULT 0,
    composite_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_listeners  BIGINT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recommendations_run_idx ON recommendations(run_id);

-- Impressions: a lightweight row recorded when a cache hit re-serves a prior
-- run (the run happened once; it was shown again).
CREATE TABLE IF NOT EXISTS impressions (
    id         UUID PRIMARY KEY,
    run_id     UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    source     TEXT NOT NULL DEFAULT 'cache_hit',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS impressions_run_idx ON impressions(run_id);

-- Events: nullable FKs, CHECK that at least one id is set. dedup_key enforces
-- idempotency ONLY when the client supplies it (partial unique index), so
-- multiple genuine clicks without a key are all recorded.
CREATE TABLE IF NOT EXISTS events (
    id          UUID PRIMARY KEY,
    run_id      UUID REFERENCES runs(id) ON DELETE CASCADE,
    rec_id      UUID REFERENCES recommendations(rec_id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    type        TEXT NOT NULL,
    target      TEXT,
    dedup_key   TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT events_one_fk CHECK (run_id IS NOT NULL OR rec_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS events_rec_idx ON events(rec_id);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id);
-- Dedup: enforced only when the caller provides a dedup_key. COALESCE the
-- nullable FKs to text so a NULL run_id/rec_id compares EQUAL across rows —
-- a plain unique index treats NULLs as distinct, which would defeat dedup for
-- rec-scoped events (run_id NULL). `ON CONFLICT DO NOTHING` (no target) uses
-- this index regardless of the expression form.
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup_idx
    ON events (type, dedup_key, COALESCE(rec_id::text, ''), COALESCE(run_id::text, ''))
    WHERE dedup_key IS NOT NULL;

-- Saved artists: server-backed bookmark, one per (user, normalized artist).
CREATE TABLE IF NOT EXISTS saved_artists (
    id               UUID PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rec_id           UUID REFERENCES recommendations(rec_id) ON DELETE SET NULL,
    artist_name      TEXT NOT NULL,
    artist_name_norm TEXT NOT NULL,
    total_listeners  BIGINT,
    top_tags         JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, artist_name_norm)
);

-- Dismissed artists: the per-user exclusion set applied post-pipeline.
CREATE TABLE IF NOT EXISTS dismissed_artists (
    id               UUID PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rec_id           UUID REFERENCES recommendations(rec_id) ON DELETE SET NULL,
    artist_name_norm TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, artist_name_norm)
);

-- Artist observations: the listener-count time series accumulated for free from
-- the getinfo calls a discovery run already makes. One row per artist per day
-- (batched INSERT .. ON CONFLICT DO NOTHING). mbid recorded when present.
CREATE TABLE IF NOT EXISTS artist_observations (
    id               BIGSERIAL PRIMARY KEY,
    artist_name_norm TEXT NOT NULL,
    mbid             TEXT,
    listeners        BIGINT NOT NULL,
    observed_on      DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (artist_name_norm, observed_on)
);
