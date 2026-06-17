# Obscurity Engine

A music discovery tool that maps your Last.fm listening history to find artists
you haven't heard yet — under-the-radar acts your taste genuinely points to,
that **haven't broken through** (under 25,000 listeners) and that you
**haven't already dug into**.

It runs entirely on the public Last.fm API. No database, no model training —
the intelligence is a deterministic dual-graph pipeline over Last.fm's
similar-artist graph and genre folksonomy.

**Live:** [obscurity-engine.vercel.app](https://obscurity-engine.vercel.app)
· **Docs:** [docs/](docs/)

## Who it's for

- **Listeners** tired of mainstream recommenders surfacing what they'd have
  found anyway, who want the deep cuts their taste actually supports.
- **People with a Last.fm history** (or who scrobble) — the engine reads your
  real listening, not a vibe.
- Underneath, a longer-term aim: help **under-discovered artists reach their
  "true 1000 fans"** by routing the long tail to the right listeners. See
  [docs/roadmap.md](docs/roadmap.md).

## What it does

- **Discovers obscure artists** from your top artists across six time windows,
  blended with recency weighting (the "MIX" mode) or from a single period.
- **Dual-graph confirmation:** a candidate found by both your similar-artist
  graph *and* your genres earns a DUAL signal (gold ✦) and a ranking bonus.
  Cross-validation is **popularity-neutral**, so genuinely obscure artists can
  earn it — not just famous ones.
- **Ranks** by `conviction × stickiness × genre-fit`, filters out the
  mainstream (25K ceiling) and what you already know, and enforces genre
  diversity.
- **Obscurity index (0–100):** how deep your results sit, as a headline number.
- **Discovery Matrix:** a 2×2 of conviction × stickiness (dot size = obscurity,
  gold = dual-signal) plus a sortable artist ledger.
- **Listen / find links** (Last.fm, Spotify, Bandcamp), a **share-card image
  export**, and **"view more"** to expand from 10 to 25 results.

## How it works (60 seconds)

1. Enter a Last.fm username.
2. **Seeds** — your top artists across 6 windows, recency-weighted (MIX) or one
   period.
3. **Two graphs in parallel** — similar-artist expansion (collaborative
   filtering) and a genre tag graph (folksonomy).
4. **Score** — conviction (seeds pointing here) × stickiness (returning
   fanbase) × genre-fit, with a cross-validation bonus for dual-signal finds.
5. **Filter & rank** — drop artists you've heard, drop anything over 25K
   listeners, diversify by genre, return up to 25.

Full detail: [docs/explanation-how-it-works.md](docs/explanation-how-it-works.md)
and [docs/explanation-scoring.md](docs/explanation-scoring.md).

## Quick start (local)

**Prerequisites:** [Rust](https://rustup.rs), [Node.js 18+](https://nodejs.org),
a free [Last.fm API key](https://www.last.fm/api/account/create).

```bash
git clone https://github.com/abyss-node/obscurity-engine.git
cd obscurity-engine
chmod +x start.sh
./start.sh        # prompts for your API key, builds, starts both servers
```

Manual setup, Docker, and troubleshooting:
[docs/howto-run-locally.md](docs/howto-run-locally.md).

## Hosted deployment

Railway (backend) + Vercel (frontend), both free-tier always-on. Note: Vercel
auto-deploys from `git push`, but **the backend deploys via `railway up` only**.
Full guide: [docs/howto-deploy.md](docs/howto-deploy.md).

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Rust · Axum · Tokio · reqwest |
| Frontend | Next.js 15 · TypeScript · Tailwind CSS · Framer Motion |
| Data | Last.fm API (stateless, no database) |
| Eval | Python offline harness with temporal holdout (`eval/`) |

## Documentation

| Doc | For |
|---|---|
| [Getting started](docs/tutorial-getting-started.md) | using the app as a listener |
| [How it works](docs/explanation-how-it-works.md) | the discovery pipeline |
| [Scoring model](docs/explanation-scoring.md) | why artists rank where they do |
| [HTTP API](docs/reference-api.md) | endpoints, schema, caching |
| [Eval harness](docs/reference-eval-harness.md) | measuring scoring changes |
| [Run locally](docs/howto-run-locally.md) | dev setup |
| [Deploy](docs/howto-deploy.md) | Railway + Vercel |
| [Roadmap](docs/roadmap.md) | what's planned and what's been tried |

## Project structure

```
obscurity-engine/
├── backend/                      # Rust · Axum API
│   └── src/
│       ├── main.rs               # server, routing, CORS, 1h result cache
│       ├── lastfm.rs             # Last.fm client + retry/backoff
│       ├── spotify.rs            # Spotify track preview + link resolution
│       ├── models.rs · utils.rs  # shared types · name normalization
│       └── pipeline/
│           ├── mod.rs            # orchestrator (seeds→tags→candidates→scoring)
│           ├── seeds.rs          # phase 1: seed artists (recency-weighted)
│           ├── tag_graph.rs      # phase 2: genre cross-validation set
│           ├── candidates.rs     # phase 3: similar-artist expansion
│           ├── scoring.rs        # phase 4: score, filter, diversify, depth score
│           └── track_*.rs        # parallel track-discovery pipeline
├── frontend/                     # Next.js 15 · TypeScript
│   └── src/
│       ├── app/page.tsx          # landing, results, period controls, share
│       └── components/           # DiscoveryMatrix, ArtistList/Card, ShareCard…
├── eval/                         # Python offline eval harness
├── docs/                         # this documentation set
├── docker-compose.yml · render.yaml · start.sh
└── DESIGN.md                     # design system
```

## Contributing

Scoring weights and constants live at the top of
`backend/src/pipeline/scoring.rs`. Any change that affects ranking should be
A/B'd in the [eval harness](docs/reference-eval-harness.md) before shipping —
that's the project's standing rule. Get a free Last.fm API key:
https://www.last.fm/api/account/create
