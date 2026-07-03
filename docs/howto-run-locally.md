# How to run the Obscurity Engine locally

This gets the backend and frontend running on your machine so you can develop
against them.

## Prerequisites

- [Rust](https://rustup.rs) (stable) — for the Axum backend
- [Node.js 18+](https://nodejs.org) LTS — for the Next.js frontend
- A free [Last.fm API key](https://www.last.fm/api/account/create)

## Option A — one command

```bash
git clone https://github.com/abyss-node/obscurity-engine.git
cd obscurity-engine
chmod +x start.sh
./start.sh
```

`start.sh` prompts for your Last.fm API key on first run, builds the backend
(~2 min the first time, ~10s after), installs frontend deps if missing, starts
both servers, and opens `http://localhost:3000`.

## Option B — manual (two terminals)

### 1. Backend (port 8080)

```bash
cd backend
cp .env.example .env
# edit .env: set LASTFM_API_KEY=your_key
cargo run --release
```

Optional `.env` vars:
- `FRONTEND_URL` — CORS origin. Must match the frontend's URL or the browser
  blocks responses. Default dev behavior allows any localhost.
- `PORT` — defaults to `8080`.
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — optional; enable direct
  Spotify links and the `/api/spotify/track` preview. Without them, the app
  uses Spotify-search links.
- `DATABASE_URL` / `LASTFM_API_SECRET` — optional Phase 1 identity/events
  persistence and login. See the next section; skip it entirely and the
  server runs exactly as before (graceful fallback).

Verify it's up:

```bash
curl http://localhost:8080/
# → ObscurityEngine Backend Alive!
```

### Optional: Postgres persistence + Last.fm login

Login, saves, dismisses, first-party events, and `/api/me/*` are all opt-in —
the app works fully without them. To turn them on locally:

```bash
docker compose up -d postgres
```

This starts the `postgres` service from `docker-compose.yml`
(`postgres:16-alpine` on host port **5433**, so it doesn't collide with a
system Postgres on the default 5432; `POSTGRES_PASSWORD=dev`; a named volume
so data survives a restart). Then in `backend/.env`:

```bash
DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres
```

Migrations run automatically on the next `cargo run` (additive-only —
nothing to run by hand). Confirm with `curl http://localhost:8080/api/status`
— `"postgres"` should read `"ok"`.

To also enable login (`connect last.fm`), get an **API secret** for your
existing Last.fm API key/account at
[last.fm/api/accounts](https://www.last.fm/api/accounts) (click your
application, the secret is next to the key) and set:

```bash
LASTFM_API_SECRET=your_secret_here
```

Without it, `/api/status` reports `"lastfm_auth": "disabled"` and the
frontend hides the login entry — this is expected, not a bug, until you set
the secret.

### 2. Frontend (port 3000)

```bash
cd frontend
echo "NEXT_PUBLIC_BACKEND_URL=http://localhost:8080" > .env.local
npm install
npm run dev
```

Open `http://localhost:3000` and enter a Last.fm username.

> **CORS gotcha:** if the backend's `FRONTEND_URL` doesn't match the port the
> frontend is actually on, the browser blocks the response and the UI shows
> "couldn't reach the service." If Next picks port 3001 because 3000 is taken,
> start the backend with `FRONTEND_URL=http://localhost:3001`.

## Option C — Docker

```bash
LASTFM_API_KEY=your_key docker compose up --build
# open http://localhost:3000
```

`docker-compose.yml` wires the backend (`:8080`, `FRONTEND_URL` preset to
`http://localhost:3000`) and frontend (`:3000`, `NEXT_PUBLIC_BACKEND_URL` baked
in) together. The `postgres` service is **not** included in this command by
default (`backend`/`frontend` don't `depends_on` it) — start it separately
with `docker compose up -d postgres` if you want persistence, per the section
above.

## Verification

1. `curl http://localhost:8080/` returns the alive message.
2. The frontend landing page loads with no console errors.
3. A discovery for a real username returns artists (first compute takes
   ~30–45s — it fans out hundreds of Last.fm calls; subsequent ones hit the
   1-hour server cache and are instant).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm run build` fails locally on `sw.js` | A `next-pwa` codegen bug trips on the apostrophe in the home-dir path. Use `npx tsc` for type-checking; Vercel builds fine. |
| Pre-existing `spotify.ts:16` TS2802 error | Harmless (es5 target). Not introduced by your change. |
| "Last.fm is rate-limiting us" (500) | You've run too many cold computes; the shared key is rate-limited (Error 29). Wait a few minutes. |
| "couldn't reach the service" | Backend not running, wrong `NEXT_PUBLIC_BACKEND_URL`, or a CORS `FRONTEND_URL` mismatch. |
| Discovery returns empty | The username has no listening history for that period — try MIX or a longer window. |

### Silent-fallback symptoms (Phase 1 persistence)

Graceful fallback is deliberate — persistence features hide or `503` instead
of half-working — but that can look like "nothing happened." **Always check
`curl http://localhost:8080/api/status` first**; it tells you exactly which
subsystem is off and why.

| Symptom | Check `/api/status` | Cause / fix |
|---|---|---|
| No "connect last.fm" text near the username input | `lastfm_auth` | `"disabled"` → `LASTFM_API_SECRET` isn't set in `backend/.env`. Set it (see above) and restart the backend. |
| Login redirects back but never signs you in | `lastfm_auth` and `postgres` | `POST /api/auth/session` 503s if either is off — both are required for login. |
| Saves/dismisses don't appear, or the save/dismiss UI never shows up on a card | `postgres` | `"disabled"` → `DATABASE_URL` unset — **intentional**, this is the graceful-fallback default, not a bug. `"error"` → `DATABASE_URL` **is** set but the DB is unreachable (Postgres not started, wrong port, container not healthy yet); run `docker compose up -d postgres` and re-check. `"ok"` but still nothing showing → check `persistence` in the raw `/api/discovery` response; a custom `api_key` request or an empty/degraded run never persists (see [reference-api.md](reference-api.md)). |
| `GET /api/me/saved` / `/api/me/data` return `401` | — | You're not logged in, or the session token expired (90 days) / was cleared. Log in again. |
| `POST /api/events` returns `503` | `postgres` | Same as the saves/dismisses row above — persistence is off or unreachable. This is why anonymous `click_listen`/`share` beacons look like they "fail silently" in devtools; they're being correctly rejected, not lost. |
| `POST /api/events` returns `410` | — | The `rec_id`/`run_id` referenced is unknown or older than the 24h TTL. Refresh the page to get a fresh run. |
| `POST /api/events` returns `429` | — | Per-IP rate limit hit (60-burst, 1/sec refill) — almost never happens organically; check you're not looping a test script against it. |

## Quick API poke

```bash
curl "http://localhost:8080/api/discovery?username=YOUR_LASTFM_NAME&period=3month"
```

(Windows note: pipe to `python -c` with `io.open(..., encoding='utf-8')` to
avoid cp1252 errors on non-ASCII artist names.)

## Related

- [reference-api.md](reference-api.md) — the endpoints you're hitting
- [reference-schema.md](reference-schema.md) — the Postgres tables behind persistence
- [explanation-privacy.md](explanation-privacy.md) — what gets stored once persistence is on
- [howto-deploy.md](howto-deploy.md) — putting it online
- [tutorial-getting-started.md](tutorial-getting-started.md) — using the app as a listener
