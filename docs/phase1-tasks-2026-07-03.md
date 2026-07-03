# Phase 1-LITE — identity + events + status (approved 2026-07-03)

Scope per the approved roadmap (traffic <50 → LITE gating): identity
primitive, minimal event capture, listener-observation writer, status
endpoint, local-dev story. Explicitly NOT in lite: adoption cron (F3),
"Your discoveries" page, weekly digests — those wait for the runs/week
threshold from the analytics baseline.

## Ground rules

- Repo `C:\Users\Arnuv'\obscurity-engine`, branch off `main`. Commit locally,
  **never push**. **No Claude attribution.** Path has an apostrophe —
  double-quote everything; `npm run build` fails on this machine (next-pwa
  apostrophe bug) — verify frontend via `npm test` + `npx tsc --noEmit`.
- **Graceful fallback is law:** with `DATABASE_URL` / `LASTFM_API_SECRET`
  unset, every request behaves byte-identically to today. New features hide
  or no-op, loudly logged only when a var is SET but broken.
- The n=348 eval campaign is running concurrently: do NOT touch `eval/**`,
  `eval/.cache/**`, or any `goal/blend-n348` files.
- Do not modify scoring logic (`pipeline/scoring.rs` math). The dismissal
  filter is a post-pipeline output filter, not a scoring change.

## Pinned API contract (both tasks build against THIS, not their own ideas)

- **Auth flow (Last.fm web auth):**
  1. FE sends user to `https://www.last.fm/api/auth?api_key=<key>&cb=<FRONTEND_URL>/auth/lastfm`
  2. Last.fm redirects back with `?token=T`; FE `POST /api/auth/session {token}`
  3. BE calls signed `auth.getSession` (requires new env `LASTFM_API_SECRET`;
     without it endpoint returns 503 `{error,code}` and FE hides login)
  4. BE upserts user (synthetic UUID id; `lastfm_username` normalized
     lowercase, rename-tolerant) and returns `{session_token, username, user_id}`
     — opaque 32-byte random token, stored server-side, 90-day expiry
  5. FE stores token in localStorage, sends `Authorization: Bearer <token>`
     on writes and personal reads. Logout = `DELETE /api/auth/session`.
- **DiscoveryResponse additions (nullable, additive):** top-level
  `run_id: string|null`, `persistence: bool`; per-item `rec_id: string|null`
  (UUIDv4). Cache hits create an `impressions` row referencing the original
  run and return the ORIGINAL run's rec_ids. With no DB: nulls + false.
- **`POST /api/events`** `{rec_id?, run_id?, type, dedup_key?}`, at least one
  id required. Types: `click_listen` (+`target`: lastfm|spotify|bandcamp|
  thisis), `save`, `unsave`, `dismiss`, `undo_dismiss`, `share`. Anonymous
  events allowed ONLY for `click_listen`/`share` (no auth); save/dismiss
  require Bearer. 400 malformed vs 410 expired/unknown rec (TTL 24h), 429
  with Retry-After (per-IP token bucket), 204 on success. Body ≤2KB. Strict
  CORS to FRONTEND_URL. Compatible with `navigator.sendBeacon`.
- **`GET /api/me/saved`** (Bearer) → saved artists with rec metadata.
  **`GET /api/me/data`** (Bearer) → full JSON export. **`DELETE /api/me/data`**
  (Bearer) → purge user rows, 204.
- **`GET /api/status`** (no auth) → per-subsystem `"disabled"|"ok"|"error"`:
  `{postgres, redis, spotify, lastfm_auth, key_pool: {keys: n}}` + `version`.
- **Error envelope everywhere new:** `{error: string, code: int}`.
- **Dismissals:** for authenticated requests, dismissed artists are filtered
  from results post-pipeline and backfilled from the candidate pool (cap 25
  preserved).

## P1-A — Backend (owns `backend/**` only)

Postgres via sqlx (runtime queries or committed `.sqlx` offline cache — a
build with no DATABASE_URL must stay green). Migrations (sqlx migrate, auto
on boot, additive-only) creating: `users`, `sessions`, `runs`,
`recommendations` (UUIDv4 rec_id), `impressions`, `events` (nullable FKs,
CHECK one set, dedup unique index), `saved_artists`, `dismissed_artists`,
`artist_observations` (one row per artist/day, batched
`INSERT..ON CONFLICT DO NOTHING`, normalized name key + mbid when present —
written as a side effect of existing getinfo fetches, ZERO added Last.fm
calls). All implementing the pinned contract: auth endpoints, events, me/*,
status, discovery additions, dismissal filter + backfill, per-IP rate
limiting, strict CORS on writes, `acquire_timeout` ≈1s, ALL persistence
writes off the response path (spawned, bounded queue, drop+log when full).
Cache-hit latency byte-identical to today (no awaited DB work on that path).

**Proof:** `cargo test` — new unit/integration tests: auth session lifecycle
(mock Last.fm), events validation matrix (400/410/429/204, dedup, anonymous
rules), dismissal filter + backfill, observation batch dedup, status 3-state,
graceful fallback (boot + serve with no DATABASE_URL, identical response
shape with nulls); `cargo build --release` green WITHOUT DATABASE_URL. If
Docker is available, run the suite against live Postgres
(`docker run -d -p 5433:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine`)
and include a live roundtrip test; if not, gate those tests behind
DATABASE_URL presence and say so.

## P1-B — Frontend (owns `frontend/src/**`, `frontend/package.json`, lock)

Per the design surface specs in docs/roadmap-10x-2026-07-02.md ("Surface
specs" section — READ IT): login entry as quiet mono text ("connect last.fm",
11px, --muted) near the username input + session display in the top bar;
auth callback route `/auth/lastfm` exchanging the token then resuming via
LoadingState; save/dismiss as mono 10px text actions in the ArtistCard
EXPANDED state (hover-reveal desktop), dismiss collapses card with existing
height animation + 5s inline undo row + backfill from the returned list;
saved marker `--text` + filled glyph (gold stays rationed); minimal Saved
view reachable via quiet top-bar text item shown only when ≥1 save;
`click_listen`/`share` events fired via sendBeacon/keepalive (anonymous ok);
save/dismiss calls with Bearer; ALL new UI hidden when `persistence:false`
or not logged in (buttons never silently no-op); loading/empty/error states
for the Saved view using existing house patterns ([ERR] envelope, EmptyState
variants).

**Proof:** `npm test` green including NEW vitest tests: event beacon payloads
(mocked), save/dismiss state machine incl. undo timer + backfill, Saved view
states, hidden-when-unsupported logic, auth token storage/attach; `npx tsc
--noEmit` (the pre-existing spotify.ts es5 error is known — no NEW errors);
zero UI change when logged out against a persistence:false backend (test).

## P1-C — Dev environment + docs (AFTER A and B are verified; owns
`docker-compose.yml`, `backend/.env.example`, `docs/**` listed here)

docker-compose gains a `postgres` service (port 5433, healthcheck) +
documented one-liner; `.env.example` gains DATABASE_URL, LASTFM_API_SECRET,
FRONTEND_URL notes; docs updated per the roadmap's docs map: reference-api.md
(all new endpoints w/ error tables in its existing style), NEW
reference-schema.md (tables + retention), NEW explanation-privacy.md (what's
stored, when, export/delete, "nothing stored without login"),
howto-run-locally.md (Postgres one-liner, auth secret setup, troubleshooting
rows for silent-fallback symptoms), howto-deploy.md (Railway Postgres addon
+ new env vars). Accuracy is the proof: every documented endpoint/shape must
match the merged A+B code exactly.

**Proof:** a checker pass listing each documented endpoint against the actual
router code paths; docker compose config validates; no other files touched.

## Sequencing

P1-A ∥ P1-B (disjoint trees, shared pinned contract) → opus verify each →
orchestrator merges → P1-C on the merged tree → verify → merge. User actions
after merge: Railway Postgres addon + DATABASE_URL, LASTFM_API_SECRET from
last.fm/api/accounts.
