# How to deploy the Obscurity Engine

The production stack is **Railway** (backend) + **Vercel** (frontend). Both have
always-on free tiers (no cold starts). This guide covers that stack plus a
Render alternative.

## Architecture

```
            push to main
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
   Vercel               Railway
 (frontend,           (backend, Rust)
  auto-deploy)         DEPLOYS VIA CLI ONLY
       │                    │
       └──── browser ───────┘
        NEXT_PUBLIC_BACKEND_URL → backend
        backend FRONTEND_URL → CORS allow
```

> **The single most important gotcha:** Railway does **NOT** auto-deploy from
> `git push`. Only Vercel does. A push updates GitHub and redeploys the
> frontend; the backend stays on its old build until you run `railway up`. If
> you change backend code, you must deploy it explicitly (see below).

## Frontend → Vercel

One-time:
1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Root directory: `frontend/`.
3. Env var: `NEXT_PUBLIC_BACKEND_URL` = your Railway backend URL.
4. Optional: `KV_REST_API_URL` + `KV_REST_API_TOKEN` (see below) to make share
   links persistent.

After that, every push to `main` auto-deploys the frontend. Nothing else to do.

## Backend → Railway

One-time:
1. New Railway project → connect the GitHub repo.
2. Root directory: `backend/`. Railway auto-detects Rust
   (`cargo build --release`).
3. Env vars:
   - `LASTFM_API_KEY` = your key (required)
   - `FRONTEND_URL` = your Vercel URL, e.g. `https://obscurity-engine.vercel.app`
     (required — this is the CORS allow-origin)
   - `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` = optional, enable direct
     Spotify artist links + the preview endpoint
   - `REDIS_URL` = optional, enable the Redis-backed result cache (see below)
   - `DATABASE_URL` = optional, enable Phase 1 identity/events persistence
     (see below)
   - `LASTFM_API_SECRET` = optional, enable Last.fm login (see below)

**Deploying a backend change** (every time backend code changes):

```bash
cd backend
railway up -d -y      # builds + deploys; -d detaches, -y skips confirmation
```

Check status / logs:

```bash
railway status        # ● Online when the new build is live
railway logs          # runtime logs (startup line, pipeline traces)
```

A deploy restarts the container (a few seconds of downtime) and clears the
1-hour result cache, so the next request recomputes fresh.

## Redis-backed result cache (backend, optional)

The backend's `/api/discovery` result cache is in-memory by default (works
fine for a single instance; misses on every restart/redeploy). Setting
`REDIS_URL` switches it to a Redis-backed cache instead — results are shared
across instances and survive redeploys.

1. Provision a Redis instance (Railway's own Redis plugin, Upstash, etc.) and
   copy its connection string, e.g. `redis://default:PASSWORD@HOST:PORT`.
2. Set `REDIS_URL` on the Railway backend service to that string.
3. Redeploy (`railway up -d -y`). Check `railway logs` for
   `Cache store: Redis (REDIS_URL set, connected)` on boot.

**Graceful fallback:** this is fully opt-in. If `REDIS_URL` is unset, unset the
in-memory cache behaves exactly as it did before this feature shipped — no
code change needed to keep the old behavior. If `REDIS_URL` is set but
malformed, or Redis is unreachable (at boot or mid-request), the backend logs
a warning and degrades to a cache miss — it never fails a request or crashes
the process.

## Postgres persistence + Last.fm login (backend, optional)

Login, saves, dismisses, first-party events, and `/api/me/*` (Phase 1) are
opt-in and off by default. Enabling them:

1. **Railway Postgres addon:** in the Railway project, **New** → **Database**
   → **Add PostgreSQL**. Railway provisions it and exposes a
   `DATABASE_URL`-shaped connection string on the Postgres service.
2. On the **backend** service, set `DATABASE_URL` — either reference the
   Postgres addon's variable directly (Railway → Variables →
   `${{Postgres.DATABASE_URL}}` reference syntax) or paste its connection
   string.
3. Redeploy (`railway up -d -y`). **Migrations run automatically on boot** —
   there is no separate migrate step, and they're additive-only (new
   columns/tables/indexes only, never a drop or rewrite), so this is safe to
   redeploy repeatedly. Check `railway logs` for `Postgres: connected and
   migrations applied`.
4. To also enable login, set `LASTFM_API_SECRET` on the backend service — the
   secret for your existing Last.fm API key, from
   [last.fm/api/accounts](https://www.last.fm/api/accounts).
5. Confirm with `curl https://<your-railway-url>/api/status` —
   `"postgres"` and `"lastfm_auth"` should both read `"ok"`.

**Graceful fallback:** if `DATABASE_URL` is unset, the server behaves
byte-identically to before this feature shipped — the new endpoints `503`
(or the frontend hides them entirely), and the discovery response's
`run_id`/`rec_id`/`persistence` fields stay `null`/`false`. If `DATABASE_URL`
is set but the database is temporarily unreachable, the server still boots
(a lazy connection pool) and serves discovery normally; persistence-backed
endpoints degrade (mostly `503`) until the database recovers, all logged
loudly rather than silently. Same story for `LASTFM_API_SECRET`: unset →
`POST /api/auth/session` 503s and the frontend hides the login entry.

See [reference-schema.md](reference-schema.md) for what gets stored and
[explanation-privacy.md](explanation-privacy.md) for the user-facing
implications.

## Persistent share links via Vercel KV (frontend, optional)

Share links (`POST /api/share`, `GET /r/{id}`) work out of the box with a
zero-config in-memory store — good enough for local dev and demos, but it's
per-process: links don't survive a redeploy and aren't shared across
serverless instances. For links that actually persist, wire up Vercel KV
(Upstash Redis under the hood):

1. Vercel dashboard → project → **Storage** → **Create Database** → **KV**
   (Marketplace / Upstash-backed). Connect it to the project.
2. Vercel auto-populates `KV_REST_API_URL` + `KV_REST_API_TOKEN` on the
   project's environment variables. Confirm they're present under **Settings →
   Environment Variables** (or `vercel env ls`).
3. Redeploy. Share links created after this point are stored in KV and will
   survive redeploys / cold starts, with the standard 30-day TTL.

**Graceful fallback:** if `KV_REST_API_URL` + `KV_REST_API_TOKEN` are both
absent, the app is unaffected — share create/read silently uses the
in-memory fallback, matching today's behavior with no new required config. If
only one of the pair is set, it's treated as "not configured" (both are
required together) and falls back the same way.

## Render (alternative to Railway)

`render.yaml` defines the backend as a Rust web service (`rootDir: backend`,
`cargo build --release`, `PORT=10000`). Set `LASTFM_API_KEY` and `FRONTEND_URL`
in the Render dashboard (`sync: false` means they're not committed). Render
auto-deploys from git.

## Verifying a deploy

```bash
# backend alive
curl https://obscurity-backend-production.up.railway.app/

# a real discovery (fresh compute ~15–45s; cached after)
curl "https://obscurity-backend-production.up.railway.app/api/discovery?username=SOMEUSER&period=3month"
```

For the frontend, load the Vercel URL on a phone and desktop and run a real
username end to end.

## Environment variables reference

| Var | Service | Required | Purpose |
|---|---|---|---|
| `LASTFM_API_KEY` | backend | yes | all Last.fm calls |
| `FRONTEND_URL` | backend | yes | CORS allow-origin (must match the site URL exactly) |
| `PORT` | backend | no | listen port (8080 default; Railway sets it; Render uses 10000) |
| `LASTFM_API_KEYS` | backend | no | comma-separated owner key pool (overrides `LASTFM_API_KEY` for the pool) |
| `KEY_STORE_PATH` | backend | no | file path on a persistent disk where opt-in user-contributed keys are saved/reloaded |
| `SPOTIFY_CLIENT_ID` | backend | no | direct Spotify artist links + preview |
| `SPOTIFY_CLIENT_SECRET` | backend | no | same |
| `CANDIDATE_SOURCE` | backend | no | candidate-generation source: `lastfm` (default) / `listenbrainz` / `blend`; unset or invalid → `lastfm` (today's behavior). See below |
| `REDIS_URL` | backend | no | Redis-backed result cache; unset → in-memory (graceful fallback) |
| `DATABASE_URL` | backend | no | Postgres persistence (identity, events, saved/dismissed, observations); unset → every persistence endpoint hides or `503`s (graceful fallback) |
| `LASTFM_API_SECRET` | backend | no | enables Last.fm login (`POST /api/auth/session`); unset → the endpoint `503`s and the frontend hides login |
| `NEXT_PUBLIC_BACKEND_URL` | frontend | yes | points the browser at the backend |
| `KV_REST_API_URL` | frontend | no | Vercel KV REST endpoint for persistent share links |
| `KV_REST_API_TOKEN` | frontend | no | Vercel KV REST token; both `KV_REST_API_URL` + this must be set together, else in-memory fallback (graceful fallback) |

### Candidate source (`CANDIDATE_SOURCE`) — the ListenBrainz blend

Discovery candidates come from Last.fm's similar-artists graph by default. Set
`CANDIDATE_SOURCE` on the backend service to change that:

- `lastfm` (default; also what unset or any unrecognized value gives) — exactly
  today's behavior, byte-identical responses. **Leave it unset to keep today's
  behavior.**
- `blend` — union Last.fm with ListenBrainz's community-listening similar-artists
  graph. This is the offline-validated win (`docs/blend-n348-2026-07-03.md`:
  +9.5% relative reach at n=348, significant in all three anchors). Additive:
  every Last.fm candidate is still there, plus the ones ListenBrainz surfaces.
- `listenbrainz` — ListenBrainz only (the structurally-different graph on its
  own; mainly for parity with the eval harness, not a recommended prod setting).

**Fail-open + caching (why `blend` is safe to flip).** The ListenBrainz arm is
additive and fail-open: it has an 8-second per-request time budget, and if
ListenBrainz is slow or down the request silently degrades to Last.fm-only
candidates — it never errors or meaningfully delays a discovery (this is the
opposite of the Last.fm arm, which stays fail-closed for pool determinism).
ListenBrainz similar-artists lookups and MusicBrainz ID resolutions are cached
through the same store as the result cache (in-memory by default, Redis when
`REDIS_URL` is set) with a **7-day TTL**, so after warm-up the blend adds little
latency. For production it is strongly recommended to run `blend` **with
`REDIS_URL` set** so the LB cache is shared across instances and survives
redeploys.

**Rollout.** Flip to `blend` only after reviewing the verdict doc. Watch the
`/api/status` `listenbrainz` field (`ok`/`error`) and the hourly metrics line
(`lb_requests`, `lb_cache_hits`, `lb_degraded`) after enabling. To roll back,
set `CANDIDATE_SOURCE=lastfm` (or unset it) and redeploy — no code change, and
the response shape is unchanged either way.

### Persisting the user-contributed key pool

By default the pool of user-shared keys is in-memory and resets on each deploy.
To keep contributions across redeploys:
1. Railway dashboard → service → **Volumes** → add a volume, mount path e.g. `/data`.
2. Set `KEY_STORE_PATH=/data/contributed_keys.json`.
3. Redeploy. New contributions are written there and reloaded on boot.

Owner keys (`LASTFM_API_KEYS`) are not stored in the file — they come from env each boot.

## Wishlist: make the backend auto-deploy too

To get backend parity with Vercel's push-to-deploy, connect the Railway service
to GitHub in the dashboard (Settings → Source → Connect Repo), set **Root
Directory** `backend` and a **Watch Path** `backend/**` (so frontend-only
pushes don't rebuild Rust). After that, pushes touching `backend/` deploy
themselves; `railway up` remains a manual override. This is on the
[roadmap](roadmap.md) but not yet wired.

## Related

- [reference-api.md](reference-api.md) — what the deployed service exposes
- [reference-schema.md](reference-schema.md) — the Postgres tables Phase 1 persistence writes
- [explanation-privacy.md](explanation-privacy.md) — what's stored, exported, and deleted
- [howto-run-locally.md](howto-run-locally.md) — the dev equivalent
- [roadmap.md](roadmap.md) — pending deploy/infra work
