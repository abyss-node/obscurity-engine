# obscurity engine

A music discovery tool that maps your Last.fm listening history to find artists you haven't heard yet — surfacing hidden connections between what you already love and what you're likely to love next.

Built around a three-phase signal pipeline: seeds (your most-played artists) → candidates (similar artists you haven't heard) → scoring (conviction × stickiness × genre fit). A "MIX" mode blends all six Last.fm time periods, weighted by recency, to give you a live picture of your current taste.

---

## How it works

1. Enter a Last.fm username
2. The engine fetches your top artists across 6 time windows (7d, 1mo, 3mo, 6mo, 1yr, all-time) and blends them with recency weighting
3. For each of your top artists, it fetches their similar artists on Last.fm
4. Candidates that appear from multiple of your seeds get a higher conviction score; the stickiness score measures fanbase loyalty via monthly/total listener ratio
5. Artists you already listen to are filtered out; results are ranked by composite score (conviction × stickiness)

---

## Quick start (local)

### Prerequisites

- [Rust](https://rustup.rs) (for the backend)
- [Node.js 18+](https://nodejs.org) LTS (for the frontend)
- A free [Last.fm API key](https://www.last.fm/api/account/create)

### One-command start

```bash
git clone https://github.com/abyss-node/obscurity-engine.git
cd obscurity-engine
chmod +x start.sh
./start.sh
```

The script will:
- Prompt you for your Last.fm API key on first run
- Build the Rust backend (~2 min first time, ~10s after)
- Install frontend npm dependencies if missing
- Start both servers and open the app at `http://localhost:3000`

### Manual setup

If you prefer to run the two services yourself:

**Backend**
```bash
cd backend
cp .env.example .env
# edit .env and add your LASTFM_API_KEY
cargo run --release
# runs on http://localhost:8080
```

**Frontend**
```bash
cd frontend
echo "NEXT_PUBLIC_BACKEND_URL=http://localhost:8080" > .env.local
npm install
npm run dev
# runs on http://localhost:3000
```

### Docker (alternative)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
LASTFM_API_KEY=your_key docker compose up --build
# open http://localhost:3000
```

---

## Hosted deployment (free)

The recommended stack is [Railway](https://railway.app) for the backend and [Vercel](https://vercel.com) for the frontend. Both have free tiers that are always-on (no cold starts).

### Backend → Railway

1. Create a new Railway project, connect this GitHub repo
2. Set the root directory to `backend/`
3. Add environment variables:
   - `LASTFM_API_KEY` = your key
   - `FRONTEND_URL` = your Vercel frontend URL (add after deploying frontend)
4. Railway auto-detects Rust and builds with `cargo build --release`

### Frontend → Vercel

1. Import this repo on [vercel.com/new](https://vercel.com/new)
2. Set the root directory to `frontend/`
3. Add environment variable:
   - `NEXT_PUBLIC_BACKEND_URL` = your Railway backend URL
4. Deploy — Vercel handles everything else for Next.js

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Rust · Axum · Tokio · reqwest |
| Frontend | Next.js 15 · TypeScript · Tailwind CSS · Framer Motion |
| Data | Last.fm API (no database, stateless) |
| Fonts | Playfair Display · IBM Plex Mono · IBM Plex Serif |

---

## Project structure

```
obscurity-engine/
├── backend/
│   ├── src/
│   │   ├── main.rs       # Axum server setup, CORS, routing
│   │   └── service.rs    # Core pipeline: seeds → candidates → scoring
│   ├── .env.example      # Copy to .env and fill in your API key
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        # Main page: input, results, period controls
│   │   │   ├── layout.tsx      # Font setup, global metadata
│   │   │   └── globals.css     # CSS custom property token system
│   │   ├── components/
│   │   │   ├── ArtistCard.tsx  # Expandable artist card with scores
│   │   │   ├── ArtistList.tsx  # Sort controls, geo filter, artist grid
│   │   │   ├── IcebergVisual.tsx # Sonar map (obscurity iceberg)
│   │   │   └── Tooltip.tsx     # Hover tooltip with 300ms delay
│   │   └── lib/
│   │       └── geoTags.ts      # Geographic tag detection and filtering
│   └── Dockerfile
├── docker-compose.yml
├── start.sh              # One-command local start script
└── DESIGN.md             # Design system reference (tokens, fonts, rules)
```

---

## Scoring reference

| Term | What it measures |
|---|---|
| **conviction** | How many of your seed artists point to this candidate. Multiple independent signals = higher confidence. |
| **stickiness** | Monthly listeners ÷ total listeners. High ratio = dedicated, returning fanbase. |
| **composite** | Conviction × stickiness. The default sort. |
| **DUAL SIGNAL** | Artist was confirmed by both the similar-artist graph AND the genre tag graph. |
| **genre fit** | How much this artist's tags overlap with your overall taste profile. |

---

## Contributing

The backend pipeline lives in `backend/src/service.rs` — it's a single file that handles all three phases. The scoring weights and constants are at the top of that file. Pull requests welcome.

Get a Last.fm API key (free): https://www.last.fm/api/account/create
