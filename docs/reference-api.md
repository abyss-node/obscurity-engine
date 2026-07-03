# HTTP API reference

The backend is an Axum (Rust) service. Discovery itself is stateless and
needs no login; a Phase 1 identity/events layer adds optional Last.fm login,
first-party event capture, and a personal data endpoint on top, all behind
graceful fallback — with no database configured, every new endpoint hides or
`503`s rather than silently no-opping, and discovery is unaffected. CORS is
locked to the configured `FRONTEND_URL` (any origin when unset — dev only) across the
whole API, not just the new endpoints. Base URL in production:
`https://obscurity-backend-production.up.railway.app`.

Endpoints below marked **Bearer** require `Authorization: Bearer <session_token>`
(see [`POST /api/auth/session`](#post-apiauthsession)); a request without one,
or with an invalid/expired token, gets `401`. Every new endpoint speaks the
same error envelope: `{ "error": "<message>", "code": <status> }`.

## `GET /`

Health check. Returns `200` with the body `ObscurityEngine Backend Alive!`.

## `GET /api/discovery`

The main artist-discovery endpoint.

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | Last.fm username. Validated: 2–15 chars, `[A-Za-z0-9_-]` only. |
| `period` | string | yes | One of `blend`, `7day`, `1month`, `3month`, `6month`, `12month`, `overall`. (`blend` = the UI's "MIX".) |
| `api_key` | string | no | A user-supplied Last.fm API key. When present, the server uses it instead of its own key **and skips the cache** (the result is computed fresh and not stored). |

### Response `200` — `DiscoveryResponse`

```jsonc
{
  "artists": [
    {
      "name": "Putridity",
      "conviction_score": 100,        // conviction × 100
      "stickiness_score": 0.42,       // monthly ÷ total listeners
      "composite_score": 42.0,        // conviction_score × stickiness × genre uplift
      "total_listeners": 24415,
      "top_tags": ["brutal death metal", "death metal", "slam"],
      "source_seeds": [               // which seeds pointed here (sorted by strength)
        { "name": "Devourment", "percentile": 3.0 }
      ],
      "cross_validated": true,        // the DUAL signal (gold ✦)
      "taste_alignment": 0.87,        // 0–1 genre overlap with your profile
      "user_playcount": 0,            // your lifetime plays of this artist
      "reengagement": false,          // true = lightly-played, resurfaced
      "velocity": null,
      "spotify_url": null,            // present only if resolved (needs Spotify creds)
      "bandcamp_url": null,           // present only if resolved server-side
      "this_is_url": null,            // Spotify "This Is {artist}" playlist, if any
      "rec_id": null                  // Phase 1: UUIDv4, or null — see below
    }
    // … up to 25 artists, composite-sorted
  ],
  "top_genres": [ { "name": "brutal death metal", "weight": 1.0 } ],
  "deepest_date": null,
  "active_seed_count": 100,
  "depth_score": 49.8,                // the obscurity index, 0–100, over the top 10
  "message": null,                    // a [WARN]-style note when results are sparse / history thin
  "run_id": null,                     // Phase 1: UUIDv4, or null — see below
  "persistence": false                // Phase 1: true only when this run was persisted
}
```

Notes:
- `artists` is capped at 25 (`MAX_RECOMMENDATIONS`) and sorted by `composite_score`.
  The frontend shows the top 10 by default and reveals the rest on "view more".
- `spotify_url` / `bandcamp_url` / `this_is_url` are omitted (not `null`) when
  unresolved. The frontend always renders Last.fm + Spotify-search + Bandcamp-search
  links and uses these exact URLs only when present.
- `message` is set when the user's history is thin (`active_seed_count < 20`) or
  results are sparse, so the UI can show an explanatory banner instead of a blank page.

**Phase 1 additions** (`run_id`, `persistence`, per-item `rec_id`) — additive
and always serialized (explicit `null`/`false`, never omitted), so old
clients ignoring them see no change:
- `persistence: true` only when this exact response was written to Postgres —
  which requires `DATABASE_URL` to be configured **and** the result to be
  non-empty (empty/degraded runs are never persisted or cached). Otherwise
  `false`, including for requests that pass a custom `api_key` (those always
  skip persistence, matching their cache-skip behavior).
  - **The frontend must treat `persistence: false` as "no save/dismiss/events
    UI"** — those actions are hidden entirely rather than rendered and
    silently failing.
- `run_id`: the persisted run's UUID when `persistence` is true, else `null`.
  Events (`share`, or any rec-scoped event) reference this or a `rec_id`.
- Per-item `rec_id`: a UUIDv4 assigned only when the run was persisted, else
  `null`. **A cache hit does not mint new rec_ids** — it returns the
  *original* run's `rec_id`s (and `run_id`), and records an `impressions` row
  against that original run rather than creating a new one.

### Other responses

| Status | When | Body |
|---|---|---|
| `200` (empty `artists`, with `message`) | user exists but has no listening history for the period | `DiscoveryResponse` with `artists: []` |
| `400` | username fails validation | `{ "error": "Invalid username…", "code": 400 }` |
| `500` | transient Last.fm failure (rate-limit / 5xx / network) after retries | `{ "error": "…rate limit…", "code": 500 }` |

The frontend distinguishes these: a 500 with a rate-limit signature shows
"Last.fm is rate-limiting us, retry"; a fetch that never connects shows
"couldn't reach the service" (and auto-retries once).

## `GET /api/discovery/tracks`

Same query parameters as `/api/discovery`. Returns a `TrackDiscoveryResponse`
(obscure *tracks* rather than artists). Functional but gated behind a
"Coming soon" overlay in the current UI.

## `GET /api/spotify/track`

Optional preview endpoint. Returns a Spotify track match (id, 30s preview URL,
open-in-Spotify URL) for `?artist=&track=`. **Returns `404` when Spotify
credentials are not configured** — which is the case in production today, so a
404 here is the normal "Spotify not set up" signal, not a bug.

## `POST /api/keys`

Opt-in: contribute a Last.fm API key to the server's rotation pool to speed up
discovery for everyone. POST (not GET) so the key never lands in a URL or log.

Request body: `{ "api_key": "<32-char key>" }`. The key is format-checked
(16–64 alphanumeric) and validated against Last.fm with a cheap real call
before being accepted.

| Response | When |
|---|---|
| `200 { "ok": true, "pool_size": N }` | added; pool now has N keys |
| `200 { "ok": true, "duplicate": true, "pool_size": N }` | already in the pool |
| `400 { "ok": false, "error": "invalid key format" }` | bad shape |
| `400 { "ok": false, "error": "key failed Last.fm validation" }` | key doesn't work |

### How the key pool works

The backend holds a pool of Last.fm keys. Owner keys come from a
comma-separated `LASTFM_API_KEYS` env var (falling back to the single
`LASTFM_API_KEY`); user-contributed keys are added at runtime via this endpoint.
`get_with_retry` round-robins across the pool per attempt and benches any key
that returns Error 29 (rate limit) for ~20s. Since Last.fm rate-limits per key,
N keys ≈ N× the aggregate limit — faster cold computes and fewer failures.
User contributions are opt-in and disclosed in the UI.

**Persistence:** set `KEY_STORE_PATH` to a file on a persistent disk (a Railway
Volume) and user-contributed keys are written there and reloaded on boot, so the
opt-in pool survives redeploys. Unset → the pool is in-memory (contributions
reset on restart). Owner keys (`LASTFM_API_KEYS`) come from env each boot and are
not written to the store.

## Identity, events, and status (Phase 1)

Everything in this section is **off by default**. With `DATABASE_URL` unset,
`POST /api/auth/session`, `POST /api/events`, and both `/api/me/*` endpoints
`503` rather than pretending to work, and the discovery response's new fields
stay `null`/`false` (see above). See
[explanation-privacy.md](explanation-privacy.md) for what these endpoints
mean for a real user, and [reference-schema.md](reference-schema.md) for the
tables behind them.

### `POST /api/auth/session`

Exchanges a Last.fm web-auth token for a session. Step 3 of the login flow:
the frontend sent the user to
`https://www.last.fm/api/auth?api_key=<key>&cb=<FRONTEND_URL>/auth/lastfm`,
Last.fm redirected back with `?token=T`, and the frontend POSTs that token
here.

Request body: `{ "token": "T" }`

| Status | When | Body |
|---|---|---|
| `200` | exchanged successfully | `{ "session_token": "<64-hex>", "username": "<Last.fm username, original case>", "user_id": "<uuid>" }` |
| `400` | malformed JSON body | `{ "error": "malformed request body", "code": 400 }` |
| `400` | empty/missing `token` field | `{ "error": "missing token", "code": 400 }` |
| `400` | Last.fm rejected the token (bad/expired) | `{ "error": "invalid or expired token", "code": 400 }` |
| `503` | `LASTFM_API_SECRET` not set — **login is off entirely**; the frontend hides the login entry when it sees this | `{ "error": "last.fm auth not configured", "code": 503 }` |
| `503` | `DATABASE_URL` not set — nowhere to mint a session | `{ "error": "persistence not configured", "code": 503 }` |
| `503` | Last.fm's `auth.getSession` failed transiently, or the session/user row couldn't be written | `{ "error": "last.fm temporarily unavailable", "code": 503 }` or `{ "error": "could not create session", "code": 503 }` |

The returned `session_token` is opaque — store it (the frontend uses
`localStorage`) and send it back as `Authorization: Bearer <session_token>`.
It expires in **90 days**; there's no refresh endpoint, so an expired token
just starts getting `401`s and the frontend re-prompts login. The backend
upserts the user by **normalized (lowercased) username**, so a
capitalization-only rename on Last.fm resolves to the same account.

### `DELETE /api/auth/session`

Logs out. Optional `Authorization: Bearer <session_token>` header — if
present and it matches a session, that session row is deleted. **Always
returns `204`**, including with no header, a malformed header, or an
already-expired/unknown token — logout is idempotent by design, never a
place to leak "was this token ever valid."

### `POST /api/events`

First-party interaction capture: clicks, saves, dismisses, shares. Body
capped at **2KB**; compatible with `navigator.sendBeacon` (the frontend
prefers it for anonymous-ok events so the beacon survives page navigation).

Request body:

```jsonc
{
  "rec_id": "uuid-or-omitted",   // at least one of rec_id/run_id required
  "run_id": "uuid-or-omitted",
  "type": "click_listen",        // click_listen | save | unsave | dismiss | undo_dismiss | share
  "target": "spotify",           // required (and only meaningful) for click_listen: lastfm | spotify | bandcamp | thisis
  "dedup_key": "optional-client-supplied-string"  // max 200 chars
}
```

**Anonymous vs. authenticated:** `click_listen` and `share` are allowed with
no `Authorization` header. `save`, `unsave`, `dismiss`, and `undo_dismiss`
always require a valid Bearer session — sent anonymously, they `401` even
before persistence is checked.

**Validation matrix** (checked in this order — an earlier failure short-circuits later checks):

| # | Check | Failure status | Error message |
|---|---|---|---|
| 1 | Per-IP rate limit (see below) | `429` + `Retry-After` header | `{ "error": "rate limit exceeded", "code": 429 }` |
| 2 | Body ≤ 2KB | `400` | `"event body too large"` |
| 3 | Body is valid JSON | `400` | `"malformed event body"` |
| 4 | `type` is one of the six known values | `400` | `"unknown event type '<type>'"` |
| 5 | `rec_id`/`run_id`, if present, parse as UUIDs | `400` | `"rec_id is not a valid id"` / `"run_id is not a valid id"` |
| 6 | At least one of `rec_id`/`run_id` is set | `400` | `"at least one of rec_id or run_id is required"` |
| 7 | `click_listen` has `rec_id` | `400` | `"click_listen requires rec_id"` |
| 8 | `click_listen` has a `target` in the valid set | `400` | `"click_listen requires a valid target"` |
| 9 | `save`/`unsave`/`dismiss`/`undo_dismiss` have `rec_id` | `400` | `"<type> requires rec_id"` |
| 10 | `dedup_key` ≤ 200 chars | `400` | `"dedup_key too long"` |
| 11 | `target` ≤ 40 chars | `400` | `"target too long"` |
| 12 | auth-required type sent without a valid Bearer session | `401` | `"authentication required for this event"` |
| 13 | `DATABASE_URL` configured at all | `503` | `"persistence not configured"` |
| 14 | if `rec_id` given: it exists **and** is within the 24h TTL | `410` | `"recommendation expired or unknown"` |
| 15 | if only `run_id` given (no `rec_id`, e.g. a `share`): the run exists | `410` | `"run expired or unknown"` |
| — | all checks pass | `204` (no body) | — |

**Rate limiting:** an in-memory per-IP token bucket — 60-token capacity,
refills 1 token/sec. The IP key is the left-most hop of `X-Forwarded-For`
(what Railway's proxy sets), or a single shared `"unknown"` bucket if the
header is absent. `Retry-After` is whole seconds until the next token is
available (always ≥ 1).

**`dedup_key` semantics:** it's an idempotency key, not a validation
constraint — the request still gets `204` either way (the write is enqueued
off the response path and never awaited). The dedup happens at write time
against a partial unique index on `(type, dedup_key, rec_id, run_id)` that
only applies **when `dedup_key` is supplied**: a repeated `(type, dedup_key,
rec_id, run_id)` tuple collapses to one row in `events`; without a
`dedup_key`, every genuine event (e.g. repeated clicks) is recorded
separately. See [reference-schema.md](reference-schema.md#events).

**Persistence is fire-and-forget:** a `204` means the event was accepted and
queued, not that it's necessarily durable yet — writes happen on a bounded
background queue (dropped + logged if the queue is ever full, which would
require a sustained DB outage under real load). `save`/`dismiss` also queue a
derived-table write (`saved_artists`/`dismissed_artists`) alongside the raw
event row.

### `GET /api/me/saved` — Bearer

Your saved artists, most recently saved first.

```jsonc
{
  "saved": [
    {
      "name": "Putridity",
      "rec_id": "uuid-or-null",        // null if the rec it was saved from had none
      "total_listeners": 24415,        // from the recommendation row; null if unavailable
      "composite_score": 42.0,
      "saved_at": "2026-07-01T12:00:00Z"
    }
  ]
}
```

| Status | When | Body |
|---|---|---|
| `200` | success | the array above (possibly empty) |
| `401` | no valid Bearer session | `{ "error": "authentication required", "code": 401 }` |
| `503` | DB read failed | `{ "error": "could not read saved artists", "code": 503 }` |

### `GET /api/me/data` — Bearer

Full JSON export of everything tied to your account: saves, dismissals,
events, and run history (period/appetite/timestamp — not the full artist
lists a run produced).

```jsonc
{
  "user": { "id": "uuid", "username": "rj" },
  "saved": [ /* same shape as GET /api/me/saved */ ],
  "dismissed": [ { "artist": "artist-name-norm", "dismissed_at": "…" } ],
  "events": [ { "type": "click_listen", "target": "spotify", "at": "…" } ],
  "runs": [ { "run_id": "uuid", "period": "1month", "appetite": "balanced", "at": "…" } ]
}
```

| Status | When | Body |
|---|---|---|
| `200` | success | the export above |
| `401` | no valid Bearer session | `{ "error": "authentication required", "code": 401 }` |
| `503` | DB read failed | `{ "error": "could not export data", "code": 503 }` |

### `DELETE /api/me/data` — Bearer

Permanently purges everything tied to your account (runs and everything that
cascades from them, then the user row and everything that cascades from
*that* — sessions, saves, dismissals). Not reversible. See
[explanation-privacy.md](explanation-privacy.md#deleting-your-data) for what
this does and doesn't cover.

| Status | When | Body |
|---|---|---|
| `204` | purged | none |
| `401` | no valid Bearer session | `{ "error": "authentication required", "code": 401 }` |
| `503` | purge failed | `{ "error": "could not delete data", "code": 503 }` |

### `GET /api/status`

No auth. Per-subsystem health, each reported as one of three states —
`"disabled"` (the feature's env var isn't set at all — intentional, not an
error) vs. `"ok"` vs. `"error"` (the var **is** set but the subsystem is
currently unreachable/misconfigured). The frontend uses this to decide what
UI to show, and it's the first thing to check when persistence-backed
features seem to silently fail — see
[howto-run-locally.md](howto-run-locally.md#troubleshooting).

```jsonc
{
  "postgres": "ok",        // "disabled" (no DATABASE_URL) | "ok" (SELECT 1 succeeds) | "error" (set but unreachable/malformed)
  "redis": "disabled",     // "disabled" (no REDIS_URL) | "ok" | "error"
  "spotify": "ok",         // "ok" (SPOTIFY_CLIENT_ID + SECRET set) | "disabled" (no error state)
  "lastfm_auth": "ok",     // "ok" (LASTFM_API_SECRET set) | "disabled" (no error state)
  "key_pool": { "keys": 3 },
  "version": "0.1.0"       // CARGO_PKG_VERSION
}
```

Always `200`. `spotify` and `lastfm_auth` are two-state (no live
connectivity check, just "is the credential present") — a bad Spotify secret
still reports `"ok"` here; you'd only see it fail on an actual
`/api/spotify/track` call.

## Caching

- **Server result cache:** keyed by `reverse_scrobble:{username}:{period}:{appetite}`
  (and an analogous `tracks:…` key for `/api/discovery/tracks`), **1-hour TTL**.
  Only non-empty results are cached. A custom `api_key` bypasses it entirely.
  Two pluggable backends, selected at boot:
  - **In-memory (default):** an `RwLock<HashMap>`. Zero config, per-instance —
    a cache miss on every fresh backend process/instance.
  - **Redis-backed (opt-in):** set `REDIS_URL` and the same cache is backed by
    Redis instead, so results are shared across backend instances and survive
    restarts/redeploys. If Redis is unreachable at boot or at request time, the
    backend logs a warning and **degrades to a cache miss** (never fails the
    request) — see [howto-deploy.md](howto-deploy.md).
- **Per-artist audit cache:** `artist.getinfo` responses are cached **24h**
  (capped at 10,000 entries) so repeated computes are cheap. Always in-memory,
  independent of `REDIS_URL`.
- **Client cache:** the frontend also caches results in `localStorage` for 15
  minutes; the "↺ refresh" control bypasses it.

## Frontend API routes (Next.js, not the Rust backend)

The following two routes are served by the **frontend** app (Next.js route
handlers), not the Axum backend above. They back the persistent share-link
feature (share a result set via a short URL that survives a page reload / a
different browser).

### `POST /api/share`

Store a share payload and return a short id. Body is the raw JSON payload
(not wrapped) — see the shape below. Max **100KB**; extra/unknown top-level
keys are rejected.

Request body (`SharePayload`):

```jsonc
{
  "username": "rj",
  "period": "6month",
  "mode": "artists",        // must be "artists" — "tracks" mode isn't shareable yet
  "appetite": "balanced",
  "recommendations": [ /* the `artists` array from /api/discovery */ ],
  "computedAt": 1751500000000  // Date.now() at compute time
}
```

| Response | When |
|---|---|
| `201 { "id": "Ltjg6OZUns" }` | stored; 10-char URL-safe id |
| `400 { "error": "invalid JSON" }` | body isn't valid JSON |
| `400 { "error": "malformed share payload" }` | fails shape/type validation |
| `413 { "error": "payload too large" }` | body exceeds 100KB |
| `500 { "error": "could not store share" }` | store write failed (e.g. KV unreachable) |

### `GET /api/share/{id}`

Fetch a previously stored payload by id. Returns the exact bytes that were
POSTed (byte-identical roundtrip), `Content-Type: application/json`.

| Response | When |
|---|---|
| `200` + the stored JSON | id exists and hasn't expired |
| `404 { "error": "share not found or expired" }` | unknown id, or past the 30-day TTL |

The human-facing page for a share is `GET /r/{id}` (a server-rendered Next.js
page, not a JSON API) — it calls the same store directly, renders the
recommendations read-only, and shows a "link expired" state on a miss.

### Storage backend

Same two-tier pattern as the backend result cache: **Vercel KV** (Upstash-Redis
REST API) when `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set, else an
in-process in-memory `Map` (zero-config default, ephemeral — lost on restart,
not shared across serverless instances). TTL is 30 days either way. See
[howto-deploy.md](howto-deploy.md) for the env var setup.

## Rate limiting & retries

Every Last.fm call goes through `get_with_retry`: up to 4 attempts with
exponential backoff (1s → 2s → 4s) plus jitter. It retries on 5xx, network
errors, and Last.fm's HTTP-200 transient error bodies (Error 29 rate-limit, 8,
11, 16). It fails fast on 4xx and permanent error codes. The pipeline bursts
(no concurrency cap on the fan-out) because it must finish within the request
budget; the jittered backoff spreads retries when a burst trips the limit.

This is separate from `POST /api/events`'s own per-IP token-bucket limiter
(see [above](#post-apievents)), which protects the backend's own write path,
not Last.fm's.

## Related

- [explanation-how-it-works.md](explanation-how-it-works.md) — what produces this response
- [explanation-scoring.md](explanation-scoring.md) — what each score field means
- [explanation-privacy.md](explanation-privacy.md) — what the identity/events endpoints store, and how to export/delete it
- [reference-schema.md](reference-schema.md) — the tables behind the Phase 1 endpoints
- [howto-run-locally.md](howto-run-locally.md) — Postgres + `LASTFM_API_SECRET` setup for local dev
- [howto-deploy.md](howto-deploy.md) — env vars (`LASTFM_API_KEY`, `FRONTEND_URL`, Spotify, Postgres, `LASTFM_API_SECRET`)
