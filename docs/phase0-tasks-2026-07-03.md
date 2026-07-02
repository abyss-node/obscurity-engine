# Phase 0 — de-risking spikes (approved 2026-07-03)

From the approved [roadmap-10x-2026-07-02.md](roadmap-10x-2026-07-02.md).
Four independent tasks. Results reshape Phases 1-3; three of the four are
experiments whose PRIMARY deliverable is a written verdict, not shipped code.

## Ground rules

- Repo `C:\Users\Arnuv'\obscurity-engine`, branch `main`. Commit locally,
  **never push** (user pushed earlier today; overnight work stays local).
- **No Claude attribution anywhere** (commits, docs, comments).
- Do NOT change scoring defaults or any shipped behavior: new eval levers
  default to current behavior; analytics must be zero-impact when its env is
  absent. Do not touch `eval/config.py` defaults except to ADD default-off
  levers.
- Be polite to external APIs: ListenBrainz labs ≈1 req/s with a descriptive
  User-Agent; use the existing Last.fm key pool + cache for anything Last.fm.
- Windows note: paths contain an apostrophe — double-quote everything;
  `npm run build` fails on this machine's path (known next-pwa bug) — verify
  frontend via `npm test` + `npx tsc --noEmit`, not `npm run build`.

## T-A — Analytics baseline (the only code-shipping task)

Frontend: add `@vercel/analytics` (`<Analytics/>` in `src/app/layout.tsx`) —
works once the user flips Analytics on in the Vercel dashboard (note this in
the report; it's a user action). Backend: per-endpoint atomic request counters
(discovery, tracks, share of key pool) logged as one structured summary line
every hour and at shutdown via a tokio interval — no new deps, no env needed,
zero behavior change.
**Proof:** `cargo test` unit test for the counter; counter line appears in a
short local run; frontend `npm test` + typecheck green; diff scoped to
layout.tsx + package.json/lock + backend main.rs (or a small metrics module).

## T-B — CEGE coverage spike (experiment → verdict)

Question: does the CEGE graph contain the artists users adopt that Last.fm's
similar-graph can't reach? Kill criterion (pre-registered): if reachable
coverage < 2× Last.fm reach, F8-as-specced dies and ListenBrainz/blend takes
the Phase-3 slot.
Method: extract the adopted-but-not-in-pool artist set from the existing eval
artifacts (`eval/under_flat_debiased_n60.json` or recompute from
`eval/cohort_debiased.txt` using the sqlite cache — do NOT re-run the full
harness for this). Then check each artist's presence AND graph-connectivity in
CEGE. First discover CEGE's actual data state (repo likely at
`C:\Users\Arnuv'\cege*` — V1 was a POC; the MusicBrainz/Wikidata ETL may not
have run). If CEGE has no usable music graph yet, run the honest proxy:
presence + relationship-degree of those artists in the MusicBrainz API (what
CEGE's ETL would ingest), rate-limited 1 req/s, and label the verdict as
proxy-based.
**Proof:** `eval/spikes/cege_coverage.py` (reproducible, documented) +
`docs/spike-cege-coverage-2026-07-03.md` with: the artist-set size, coverage
numbers, the 2× criterion verdict (PASS / FAIL / PROXY-{result}), and
methodology caveats. No changes outside eval/spikes/ + docs/.

## T-C — ListenBrainz candidate-source A/B (experiment → verdict)

Add a candidate-source lever to the eval harness ONLY (not the Rust backend):
`candidate_source = "lastfm" (default) | "listenbrainz" | "blend"` in
`eval/config.py`, implemented in `eval/pipeline.py` (or a new
`eval/listenbrainz.py`) against the labs similar-artists endpoint
(`labs.api.listenbrainz.org/similar-artists/json`), with sqlite caching like
the Last.fm client and artist-name↔MBID resolution handled explicitly (report
the resolution miss-rate — it's part of the answer).
Run: de-biased cohort, single anchor 2026-06-10, n≈54 first pass —
`listenbrainz` and `blend` vs the existing `lastfm` baseline artifact, paired
bootstrap. Headline metrics: reach, pure-discovery hits, obscW@k, MRR.
**Proof:** harness runs complete; artifacts
`eval/lb_debiased_n54.json` + `eval/blend_debiased_n54.json`; results table +
verdict in `docs/spike-listenbrainz-2026-07-03.md` (directional at this n —
say so); `git diff` shows default config behavior unchanged (running with
defaults reproduces baseline numbers).

## T-D — Spotify quota feasibility (research → verdict, no code)

Answer: can this app realistically get Spotify API access at the scale F5
assumes? Research (WebSearch + official docs): current development-mode user
cap and the extension/review process (what Spotify approves, typical
timelines, individual-vs-org eligibility); the Nov 2024 endpoint deprecations
for new apps — specifically whether the endpoints F5/F6 need (top artists,
recently played, search, playlist create) are still granted to new apps;
any 2025-2026 policy changes.
**Proof:** `docs/spike-spotify-quota-2026-07-03.md` with sources (URLs),
a verdict (GO / GO-WITH-CAPS / NO-GO for F5), and the recommended path
(e.g. stay under dev-mode cap for beta, apply for extension at threshold X).

## File ownership (disjoint)

- T-A: `frontend/src/app/layout.tsx`, `frontend/package.json`,
  `frontend/package-lock.json`, `backend/src/*` (metrics only)
- T-B: `eval/spikes/**`, `docs/spike-cege-coverage-2026-07-03.md`
- T-C: `eval/config.py` (additive lever), `eval/pipeline.py` /
  `eval/listenbrainz.py`, `eval/lb_*.json`, `docs/spike-listenbrainz-2026-07-03.md`
- T-D: `docs/spike-spotify-quota-2026-07-03.md`

T-B and T-C both read the eval cache but own disjoint files; T-C owns
`eval/config.py`/`eval/pipeline.py` exclusively.
