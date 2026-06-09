# obscurity engine

A music discovery tool that maps your Last.fm listening history to find artists you haven't heard yet — surfacing hidden connections between what you already love and what you're likely to love next.

Built around a dual-graph pipeline: seeds (your most-played artists) → candidates (similar-artist graph + genre tag graph) → scoring (conviction × stickiness × genre fit). A "MIX" mode blends all six Last.fm time periods, weighted by recency, to give you a live picture of your current taste.

---

## How it works

1. Enter a Last.fm username
2. The engine fetches your top artists across 6 time windows (7d, 1mo, 3mo, 6mo, 1yr, all-time) and blends them with recency weighting
3. Two pipelines run in parallel: similar-artist expansion (collaborative filtering) and genre tag graph (folksonomy-based)
4. Candidates confirmed by both pipelines get a DUAL SIGNAL badge and a conviction bonus
5. Artists you already listen to are filtered out; results above 25K listeners are excluded; remaining candidates are ranked by composite score (conviction × stickiness) with genre diversity enforcement

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
│   │   ├── main.rs              # Axum server setup, CORS, routing, cache
│   │   ├── lastfm.rs            # Last.fm API client with retry logic
│   │   ├── models.rs            # Shared data types
│   │   ├── spotify.rs           # Spotify client (track lookup for preview)
│   │   ├── utils.rs             # Artist name normalization, period parsing
│   │   └── pipeline/
│   │       ├── seeds.rs         # Phase 1: collect seed artists from scrobble history
│   │       ├── candidates.rs    # Phase 2: similar-artist expansion
│   │       ├── tag_graph.rs     # Phase 2b: genre tag graph (cross-validation)
│   │       ├── scoring.rs       # Phase 3: score, rank, diversity pass, depth score
│   │       ├── track_seeds.rs   # Track mode: seed tracks from listening history
│   │       ├── track_candidates.rs  # Track mode: candidate expansion
│   │       └── track_scoring.rs     # Track mode: scoring and ranking
│   ├── .env.example             # Copy to .env and fill in your API key
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx         # Main page: landing, results, period controls, share
│   │   │   ├── layout.tsx       # Font setup, global metadata
│   │   │   └── globals.css      # CSS custom property token system
│   │   ├── components/
│   │   │   ├── ArtistCard.tsx   # Expandable artist card with scores and via overlay
│   │   │   ├── ArtistList.tsx   # Sort controls, geo/via filters, artist grid
│   │   │   ├── TrackCard.tsx    # Track card with Spotify lookup
│   │   │   ├── IcebergVisual.tsx # Sonar depth map
│   │   │   ├── ErrorState.tsx   # [ERR] SONAR_FAILURE with retry
│   │   │   ├── LoadingState.tsx # Scan bar animation
│   │   │   ├── OnboardingGuide.tsx # Last.fm setup instructions
│   │   │   └── Tooltip.tsx      # Hover tooltip with delay
│   │   └── lib/
│   │       ├── geoTags.ts       # Geographic tag detection, canonical map, formatting
│   │       ├── scoring.ts       # Depth score → prose tier labels
│   │       ├── cache.ts         # localStorage result cache
│   │       └── spotify.ts       # Spotify OAuth + playlist creation
│   └── Dockerfile
├── docker-compose.yml
├── start.sh                     # One-command local start script
└── DESIGN.md                    # Design system reference (tokens, fonts, rules)
```

---

## Scoring reference

| Term | What it measures |
|---|---|
| **conviction** | How many of your seed artists point to this candidate. Multiple independent signals = higher confidence. |
| **stickiness** | Monthly listeners ÷ total listeners. High ratio = dedicated, returning fanbase. |
| **composite** | Conviction × stickiness. The default sort. |
| **DUAL** | Artist was confirmed by both the similar-artist graph AND the genre tag graph. |
| **genre fit** | How much this artist's tags overlap with your overall taste profile. |
| **obscurity index** | Conviction-weighted average of `sqrt(1 − listeners/25000)` across all results. 0 = ceiling (25K listeners), 100 = completely unknown. |

---

## Contributing

The backend pipeline is split across `backend/src/pipeline/`. Scoring weights and constants live at the top of `scoring.rs` and `track_scoring.rs`. The 25K listener ceiling is `MAX_LISTENER_CEILING` in both files.

Get a Last.fm API key (free): https://www.last.fm/api/account/create
