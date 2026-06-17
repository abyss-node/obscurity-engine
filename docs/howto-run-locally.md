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

Verify it's up:

```bash
curl http://localhost:8080/
# → ObscurityEngine Backend Alive!
```

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
in) together.

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

## Quick API poke

```bash
curl "http://localhost:8080/api/discovery?username=YOUR_LASTFM_NAME&period=3month"
```

(Windows note: pipe to `python -c` with `io.open(..., encoding='utf-8')` to
avoid cp1252 errors on non-ASCII artist names.)

## Related

- [reference-api.md](reference-api.md) — the endpoints you're hitting
- [howto-deploy.md](howto-deploy.md) — putting it online
- [tutorial-getting-started.md](tutorial-getting-started.md) — using the app as a listener
