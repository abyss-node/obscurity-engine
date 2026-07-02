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
| `REDIS_URL` | backend | no | Redis-backed result cache; unset → in-memory (graceful fallback) |
| `NEXT_PUBLIC_BACKEND_URL` | frontend | yes | points the browser at the backend |
| `KV_REST_API_URL` | frontend | no | Vercel KV REST endpoint for persistent share links |
| `KV_REST_API_TOKEN` | frontend | no | Vercel KV REST token; both `KV_REST_API_URL` + this must be set together, else in-memory fallback (graceful fallback) |

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
- [howto-run-locally.md](howto-run-locally.md) — the dev equivalent
- [roadmap.md](roadmap.md) — pending deploy/infra work
