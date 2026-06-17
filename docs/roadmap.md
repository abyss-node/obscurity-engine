# Roadmap & what's in the pipeline

Where the project is headed, what's queued, and what's been tried and parked.
This is the living backlog — it reflects decisions made through the eval
harness and product calls, not a fixed plan.

## The north star

Help **under-discovered artists reach their "true 1000 fans."** The reframe:
obscurity isn't a raw listener count, it's **under-reach** — distance to a
sustainable ~1000-true-fans line, relative to an artist's engagement, genre,
and country. The flat 25K listener ceiling is a stand-in for this; the real
model is per-user and genre-relative. The listener-facing app is the front
door; the deeper goal is reach for the long tail.

## Near-term (queued)

| Item | Status |
|---|---|
| **Spotify direct artist links** | Resolver + frontend are wired; needs `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` on Railway. Without creds, Spotify links are search fallbacks. Spotify's API won't IP-block Railway, so this works once creds are set — no code change. |
| **Railway backend auto-deploy** | Connect the Railway service to GitHub (root `backend`, watch path `backend/**`) so backend pushes deploy themselves, matching Vercel. Dashboard steps in [howto-deploy.md](howto-deploy.md); not yet wired (still `railway up`). |
| **Tracks discovery mode** | The track pipeline (`track_seeds`/`track_candidates`/`track_scoring`) is functional but gated behind a "Coming soon" overlay. Plan: quality-tune and ship. |

## Strategic (the big bets)

- **"True 1000 fans" threshold model.** Replace the flat 25K ceiling with a
  per-user, devotion-aware, genre-relative sustainability line
  (`true_fans` / `discovery` threshold models in `eval/config.py`).
  **Eval result (2026-06-18): NO on the current cohort.** Both models "win" on
  reach/precision/MRR only by surfacing non-obscure artists (mean listeners 50K
  for true_fans, 1.2M for discovery); on the obscurity-weighted metric flat
  wins. Re-impose an obscurity ceiling and discovery collapses to ≈ flat. The
  *boundary* isn't the lever. Revisit only with (a) a de-biased multi-account
  cohort that could expose real per-user effects the current bubbled 26-user
  cohort masks, or (b) richer reach data (CEGE). Not shipped.
- **CEGE integration.** The recurring finding: Last.fm's similar-artist graph
  is genre-clustering and popularity-biased, which structurally caps obscure
  discovery. Richer graph data (the CEGE entertainment graph) is the real
  unlock. Scoring R&D was deliberately moved to the Python eval harness to stay
  CEGE-portable.

## Scoring experiments (evaluated)

Run through the [eval harness](reference-eval-harness.md). Most levers exist in
`eval/config.py`, default-off.

| Experiment | Result |
|---|---|
| **Cross-validation de-biasing** (genre-overlap dual-signal) | ✅ **Shipped.** Coverage 0.3→3 artists/user, adoptions 0→0.27, no regression. |
| Underexplored novelty model | ✅ Shipped (`mult=1.0`; `0.5` only lost hits). |
| Temporal seed weighting (#4) | ❌ A/B'd NO. |
| Genre-relative ceiling (#2) | ❌ A/B'd NO. |
| **Two-hop "similar-of-similar" expansion (#3)** | ❌ **A/B'd NO.** Reach stayed flat at 0.09 across candidate caps (300/600/1000) and obscurity got worse — the artists users adopt aren't in the Last.fm similar-graph even two hops out. Strong evidence that reach is capped by the data source, not traversal. |
| Match-weighted conviction (#1) | ❌ A/B'd NO. Lifts MRR but drags precision/recall/obscurity and doesn't touch reach. |
| Velocity / momentum signal (#5) | Parked. |
| Wider/more-specific tag derivation for cross-validation | Tested; little gain for added API cost — not shipped (genre-overlap won instead). |

## Data / eval

- **De-biased cohort run.** The current eval cohort (~26 users) is one bubbled
  friend cluster. `eval/build_cohort.py` builds a cohort from **multiple
  disconnected seed accounts** — running it with several unrelated seeds is
  needed before trusting absolute eval numbers.

## Polish / deferred

- Design elements from `design-preview.html` worth revisiting.
- Vercel KV share-link persistence (shareable result URLs that survive).
- Redis cache (replace the in-memory result cache for multi-instance scaling).
- Track-pipeline quality tuning (prerequisite for shipping tracks mode).

## Recently shipped (for context)

- **Rotating Last.fm key pool** (speed/reliability): `LASTFM_API_KEYS` env pool +
  round-robin with bench-on-429, plus an opt-in `POST /api/keys` so users can
  share their key to the pool (validated, deduped, never logged). More keys =
  more aggregate rate limit = faster cold computes, fewer Error-29 failures.
- Listen/find links (Last.fm + Spotify + Bandcamp, with search fallbacks).
- Share-card PNG export.
- Empty / error / loading / onboarding states.
- "View more" → up to 25 recommendations.
- Mobile-responsive layout.
- Auto-retry on transient network drops.
- Deterministic pipeline (fail-closed fan-out + sort tiebreakers) + 10→25 cap.
- Discovery Matrix + artist ledger redesign.

## Related

- [reference-eval-harness.md](reference-eval-harness.md) — how experiments are measured
- [explanation-scoring.md](explanation-scoring.md) — the model these levers tune
