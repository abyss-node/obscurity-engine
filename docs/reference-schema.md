# Database schema reference

The Phase 1 Postgres schema (`backend/migrations/0001_phase1_identity_events.sql`),
applied automatically on boot via `sqlx::migrate!` when `DATABASE_URL` is set.
Additive-only: every future migration adds columns/tables/indexes, never drops
or rewrites one — rollback is "revert the binary," not "revert the schema."
All UUIDs are generated application-side (uuid v4), so no Postgres extension
(pgcrypto/uuid-ossp) is required.

This only exists when persistence is on. With `DATABASE_URL` unset, none of
these tables are ever touched — see
[explanation-privacy.md](explanation-privacy.md) for what that means for you.

## `users`

One row per person who has ever logged in via Last.fm web auth.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Synthetic — deliberately not the Last.fm username, since usernames get renamed. |
| `lastfm_username` | TEXT UNIQUE NOT NULL | Stored **normalized (lowercase)**. A case-only rename resolves to the same row via `upsert_user`'s `ON CONFLICT`. |
| `settings` | JSONB | Reserved, unused in Phase 1. |
| `created_at` | TIMESTAMPTZ | Default `now()`. |

## `sessions`

Login sessions for the Bearer-token auth flow.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID → `users(id)` | `ON DELETE CASCADE`. |
| `token_hash` | TEXT UNIQUE NOT NULL | sha256-hex of the 32-byte session token. **The raw token is never stored** — see [explanation-privacy.md](explanation-privacy.md). |
| `created_at` | TIMESTAMPTZ | |
| `expires_at` | TIMESTAMPTZ NOT NULL | 90 days from mint time (`auth::SESSION_TTL_DAYS`). `lookup_session` filters `expires_at > now()`; expired rows just stop resolving (no cleanup job in Phase 1). |

Indexed on `user_id`.

## `runs`

One row per fresh (non-cache-hit) discovery compute.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | This is the `run_id` returned in `DiscoveryResponse`. |
| `user_id` | UUID → `users(id)`, nullable | `ON DELETE SET NULL`. NULL for anonymous runs (typed username, no session). |
| `username` | TEXT NOT NULL | The Last.fm account that was **analyzed** — not necessarily the logged-in user. |
| `period` | TEXT NOT NULL | e.g. `1month`, `overall`. |
| `appetite` | TEXT NOT NULL | `new` / `low` / `balanced` / `high`. |
| `depth_score` | DOUBLE PRECISION | Default 0. |
| `active_seed_count` | INTEGER | Default 0. |
| `top_genres` | JSONB | Snapshot of the response's `top_genres`. |
| `created_at` | TIMESTAMPTZ | |

Indexed on `user_id`. A cache hit does **not** create a new run — it enqueues
an `impressions` row referencing the original run instead.

## `recommendations`

One row per artist shown **or held in reserve** (for dismissal backfill) in a
run.

| Column | Type | Notes |
|---|---|---|
| `rec_id` | UUID PK | Capability-style UUIDv4 — unguessable, referenced by events. |
| `run_id` | UUID → `runs(id)` NOT NULL | `ON DELETE CASCADE`. |
| `artist_name` | TEXT NOT NULL | |
| `artist_name_norm` | TEXT NOT NULL | Normalized name key, used for save/dismiss set membership and for joining observations. |
| `rank` | INTEGER NOT NULL | 1-based, across the visible response then the reserve. |
| `conviction_score` | INTEGER | Default 0. |
| `composite_score` | DOUBLE PRECISION | Default 0. |
| `total_listeners` | BIGINT | Default 0. |
| `created_at` | TIMESTAMPTZ | The TTL clock for `POST /api/events` — a rec is only referenceable for **24h** from this timestamp (`db::REC_TTL`); past that, `rec_meta_fresh` returns `None` and the endpoint answers `410`. |

Indexed on `run_id`.

## `impressions`

A lightweight marker recorded when a cache hit re-serves a prior run (the
compute happened once; it was shown again).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `run_id` | UUID → `runs(id)` NOT NULL | `ON DELETE CASCADE`. |
| `source` | TEXT NOT NULL DEFAULT `'cache_hit'` | Only value written today. |
| `created_at` | TIMESTAMPTZ | |

Indexed on `run_id`. Written off the response path (`try_send`, never
awaited) so a cache hit's latency is unaffected.

## `events`

First-party interaction log: clicks, saves, dismisses, shares.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `run_id` | UUID → `runs(id)`, nullable | `ON DELETE CASCADE`. |
| `rec_id` | UUID → `recommendations(rec_id)`, nullable | `ON DELETE CASCADE`. |
| `user_id` | UUID → `users(id)`, nullable | `ON DELETE SET NULL`. NULL for anonymous `click_listen`/`share` events. |
| `type` | TEXT NOT NULL | One of `click_listen`, `save`, `unsave`, `dismiss`, `undo_dismiss`, `share`. |
| `target` | TEXT | Only set (and required) for `click_listen`: `lastfm`\|`spotify`\|`bandcamp`\|`thisis`. |
| `dedup_key` | TEXT | Client-supplied idempotency key (optional). |
| `occurred_at` | TIMESTAMPTZ | |

`CHECK` constraint `events_one_fk`: at least one of `run_id`/`rec_id` must be
set — matches the API contract's "at least one id required."

Indexed on `rec_id` and `run_id` separately.

**Dedup rule:** a partial unique index —

```sql
CREATE UNIQUE INDEX events_dedup_idx
    ON events (type, dedup_key, COALESCE(rec_id::text, ''), COALESCE(run_id::text, ''))
    WHERE dedup_key IS NOT NULL;
```

— enforces idempotency **only when the caller supplies a `dedup_key`**.
`rec_id`/`run_id` are coalesced to text first because a plain unique index
treats two NULLs as distinct rows, which would silently defeat dedup for any
rec-scoped event (where `run_id` is always NULL). Events without a
`dedup_key` are never deduplicated — repeated genuine clicks all persist.
Writes use `INSERT ... ON CONFLICT DO NOTHING` against this index, so a
retried beacon (e.g. `sendBeacon` firing twice) collapses to one row.

## `saved_artists`

The user's server-backed bookmark list (drives `GET /api/me/saved`).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID → `users(id)` NOT NULL | `ON DELETE CASCADE`. |
| `rec_id` | UUID → `recommendations(rec_id)`, nullable | `ON DELETE SET NULL` — a save survives its originating rec_id expiring. |
| `artist_name` | TEXT NOT NULL | |
| `artist_name_norm` | TEXT NOT NULL | |
| `total_listeners` | BIGINT | Nullable; not currently populated by the write path (joined from `recommendations` at read time instead). |
| `top_tags` | JSONB | Reserved, unused in Phase 1. |
| `created_at` | TIMESTAMPTZ | |

`UNIQUE (user_id, artist_name_norm)` — one save per artist per user;
re-saving updates the row's `rec_id` (`ON CONFLICT ... DO UPDATE`) rather than
duplicating.

## `dismissed_artists`

The user's per-artist exclusion set, applied as a post-pipeline output filter
on every discovery response (never a scoring change).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID → `users(id)` NOT NULL | `ON DELETE CASCADE`. |
| `rec_id` | UUID → `recommendations(rec_id)`, nullable | `ON DELETE SET NULL`. |
| `artist_name_norm` | TEXT NOT NULL | |
| `created_at` | TIMESTAMPTZ | |

`UNIQUE (user_id, artist_name_norm)` — `dismiss` inserts with
`ON CONFLICT DO NOTHING`; `undo_dismiss` deletes the row outright (no
retention of dismissal history once undone).

## `artist_observations`

A listener-count time series accumulated as a side effect of discovery runs
— **zero added Last.fm calls**: it's written from the `artist.getinfo`
listener counts a run already fetches.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `artist_name_norm` | TEXT NOT NULL | |
| `mbid` | TEXT | Recorded when present; currently always NULL (the write path doesn't carry an mbid yet — see `ObsRecord`). |
| `listeners` | BIGINT NOT NULL | |
| `observed_on` | DATE NOT NULL | Default `(now() AT TIME ZONE 'utc')::date`. |
| `created_at` | TIMESTAMPTZ | |

`UNIQUE (artist_name_norm, observed_on)` — **one row per artist per UTC day**.
Writes are batched `INSERT ... ON CONFLICT (artist_name_norm, observed_on) DO
NOTHING`, and the batch is deduplicated in-memory first (`dedup_observations`)
so a single run can't collide with itself inside one `INSERT` — Postgres
rejects duplicate keys within a single statement. Across runs on the same
day, the first observation wins; there is no "latest wins" update.

## Retention summary

| Table | Retention |
|---|---|
| `sessions` | 90 days from creation (`expires_at`); no active cleanup job — expired rows simply stop authenticating. |
| `recommendations` | No TTL on the row itself, but only referenceable by `POST /api/events` for 24h from `created_at` (`REC_TTL`) — after that, an event against it 410s. |
| `saved_artists` / `dismissed_artists` | Until the user unsaves/undoes, or calls `DELETE /api/me/data` (full purge). |
| `events`, `impressions`, `runs`, `artist_observations` | No TTL — retained indefinitely, deleted only via `DELETE /api/me/data` (for rows keyed to that user) or manual ops. |

`DELETE /api/me/data` (`Db::purge_user`) deletes all `runs` rows for the
user (cascading to their `recommendations`, `impressions`, and `events` via
`ON DELETE CASCADE`), then the `users` row itself (cascading `sessions`,
`saved_artists`, `dismissed_artists`).

## Related

- [explanation-privacy.md](explanation-privacy.md) — what's stored, when, and how to delete it
- [reference-api.md](reference-api.md) — the endpoints that read/write these tables
- `backend/migrations/0001_phase1_identity_events.sql` — the source of truth
