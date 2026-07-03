# Spike T-B — CEGE coverage (Phase 0 de-risking)

**Date:** 2026-07-03
**Verdict:** **PROXY-PASS** (proxy-based; see caveats) — 7.78x Last.fm reach vs. a 2x kill line.
**Status of the real target:** the CEGE graph is **not populated** on this machine, so this
is a **MusicBrainz proxy** measurement, explicitly labelled as such.

---

## Question and pre-registered kill criterion

Does a semantic entity graph (CEGE) contain the artists users actually *adopt* that
Last.fm's similar-artists graph **cannot reach**? Pre-registered kill criterion from the
approved roadmap:

> If reachable coverage < **2x** Last.fm reach, feature **F8-as-specced dies** and
> ListenBrainz/blend takes the Phase-3 slot.

"Reach" is the harness's own definition (`eval/metrics.py`): `reach = in_pool / eligible`,
where `eligible` = obscurity-eligible (<=25k-listener) adopted artists in the holdout window
and `in_pool` = those the Last.fm similar-graph actually surfaced as candidates. The
**adopted-but-not-in-pool** set is therefore `eligible - in_pool`: the artists a user came to
love that Last.fm's graph structurally missed. That set is what an alternative graph (CEGE)
would need to reach to be worth building.

---

## Method

Reproducible script: [`eval/spikes/cege_coverage.py`](../eval/spikes/cege_coverage.py).

**Invocation** (run from the repo `eval/` dir, where the 3.9 GB harness cache lives; a
placeholder `LASTFM_API_KEY` only satisfies `config.py`'s import-time check — the spike does
**no** Last.fm network I/O):

```
# Phase A only — reconstruct the missed set from cache, no network:
LASTFM_API_KEY=cacheonly python spikes/cege_coverage.py --phase a

# Full spike — reconstruct + MusicBrainz proxy on a seeded 200-artist sample:
LASTFM_API_KEY=cacheonly python spikes/cege_coverage.py --phase ab --sample 200 --seed 1729
```

(For this run the cache was passed explicitly with
`--cache "C:\Users\Arnuv'\obscurity-engine\eval\.cache\lastfm.sqlite"` because the isolated
worktree has no `.cache/`; from a normal checkout the default path resolves to the real cache.)

**Phase A — reconstruct the missed set (offline).** The script rebuilds the exact `Config`
from the shipped artifact `eval/under_flat_debiased_n60.json` and replays the harness's own
`run_user` (imported from `eval/pipeline.py`) in a **cache-only, read-only** mode: a
`CacheOnlyClient` answers every request from the on-disk sqlite and *raises on a miss* instead
of calling Last.fm; the cache is opened `mode=ro` so it can neither be mutated nor grown. This
reproduces `ground_truth / eligible / in_pool` for the same 54 non-skipped users as the
artifact **without invoking the full harness** (`harness.py` is never run). The union of
`eligible - in_pool` across users is the missed set, de-duplicated by normalized artist name;
display names are recovered from the (cached) holdout `getRecentTracks` pages.

**CEGE data-state discovery.** The script inspects the CEGE repo (`C:\Users\Arnuv'\cege`) and
classifies `data/`. Result: `data/` contains only **`seed_creators.sql`, `seed_edges.sql`,
`seed_ips.csv`, `seed_works.csv`** — seed stubs, **no populated graph DB** (no
`.db/.sqlite/.dump/.parquet/.duckdb`). CEGE V1 was a POC; **its MusicBrainz/Wikidata ETL has
not run.** There is no music graph to query, so the honest proxy path is taken.

**Phase B — MusicBrainz proxy (labelled).** MusicBrainz is exactly what CEGE's ETL would
ingest, so it is the honest stand-in. For a **seeded random sample of 200** of the 2,709 missed
artists (`random.Random(1729)`), the script queries the MusicBrainz web service
(`https://musicbrainz.org/ws/2`) for two things:

- **Presence** — `GET /artist?query=artist:"NAME"` with a normalized-name match (or a
  score >= 90 top hit).
- **Connectivity** — for present artists, `GET /artist/{mbid}?inc=artist-rels` and count the
  artist-artist relationships. A degree >= 1 = a **non-island node** CEGE's relationship graph
  could route through.

Requests are **rate-limited to <=1 req/s** (1.1 s min interval) with the descriptive
User-Agent `ObscurityEngine-CEGE-CoverageSpike/1.0 ( gauravg@deepnative.ai )`, per
MusicBrainz's access policy; raw responses are cached under `eval/spikes/.mbcache/` (not
committed) so re-runs are free and resumable. This run made **348** MB requests.

**Coverage model.** The missed set *is* `eligible - in_pool`, so `missed / eligible =
1 - reach_lastfm`. If CEGE could route to fraction `c` of the missed set, its reach would be
`reach_cege = reach_lastfm + c * (1 - reach_lastfm)`. We report `c` as both the **present**
rate (loose upper bound) and the stricter **connected** rate (the headline).

---

## Results (real numbers)

### Phase A — the missed set (fully offline)

| quantity | value |
|---|---|
| artifact | `under_flat_debiased_n60.json` (anchor 2026-06-10) |
| users reconstructed | **54 / 54** (0 cache-incomplete) |
| cache hits / misses | 38,811 / **0** (no network) |
| pooled `eligible` | 2,895 |
| pooled `in_pool` | 144 |
| **Last.fm pooled reach** (`in_pool/eligible`) | **0.0497 (4.97%)** — matches the artifact aggregate |
| **adopted-but-not-in-pool, unique** | **2,709 artists** |

### Phase B — MusicBrainz proxy (seeded sample n=200 of 2,709, seed=1729, 348 MB requests)

| metric | count | rate |
|---|---|---|
| **present** in MusicBrainz | 148 / 200 | **74.0%** |
| **connected** (>=1 artist-artist rel) | 71 / 200 | **35.5%** |
| present-but-island (0 rels) | 77 / 148 | — |
| relationship degree among connected | median **2**, max **20** | — |

Examples of reachable (connected) missed artists: *Ryujin, Dymytry Paradox, Barry Booth,
Jessie Montgomery, François-Bernard Mâche, DJ Red Alert*.

### The 2x criterion

| reach model | value | ratio vs. Last.fm (0.0497) | vs. 2x kill line |
|---|---|---|---|
| Last.fm (baseline) | 0.0497 | 1.00x | — |
| **CEGE proxy, connected-only (headline)** | **0.3871** | **7.78x** | **PASS** |
| CEGE proxy, present (loose upper bound) | 0.7529 | 15.14x | pass |

Even the conservative connected-only estimate clears the 2x line by ~3.9x. A normal-approx
95% CI on the 35.5% connected rate (n=200) is roughly ±6.6% -> [28.9%, 42.1%], i.e. a reach
ratio of ~6.5x–8.9x — the PASS is robust to sampling noise and nowhere near the kill line.

**Verdict: PROXY-PASS.**

---

## Interpretation and caveats

- **This is a proxy, not CEGE.** CEGE's graph is unbuilt (seed stubs only), so we measured the
  source it would ingest (MusicBrainz). The verdict is labelled `PROXY-PASS` accordingly. It
  should be re-confirmed against the real graph once CEGE's ETL runs.
- **Presence/degree is an UPPER BOUND on routable reach.** A present, connected node is
  *necessary* but not *sufficient*: the proxy does not verify that a graph **path** exists from
  a given user's seed artists to the adopted artist. Actual routable reach will be below the
  35.5% connected figure. Because the margin over the 2x line is so large (7.78x), the verdict
  survives a substantial haircut, but the real number should be measured on the built graph.
- **The connected rate is also conservative in the other direction.** MusicBrainz artist-artist
  relations are sparse and hand-curated (hence 77/148 present artists are islands). CEGE would
  *additionally* ingest Wikidata edges and derive similarity from shared releases/labels/areas
  and co-occurrence/embeddings — so CEGE's effective connectivity would likely exceed MB's raw
  `artist-rels`. 35.5% is a floor for what an entity-graph could wire up.
- **The deepest tail escapes even MusicBrainz.** 26% of the missed set isn't confidently
  present in MB at all — ultra-local/self-released artists that CEGE's ETL would also miss.
  CEGE expands reach dramatically but does not make the long tail fully reachable.
- **Reach is measured against `eligible`** (adopted artists under the 25k-listener ceiling),
  matching the harness `reach` definition, so the comparison is apples-to-apples with the
  shipped Last.fm baseline.

## Bottom line for F8

The adopted-but-not-in-pool gap is real and large (2,709 unique artists; Last.fm reaches only
~5% of eligible adoptions), and the graph source CEGE would ingest can connect a large fraction
of exactly those missed artists — **7.78x Last.fm reach on the conservative proxy, versus a 2x
kill line**. On the evidence available, **F8-as-specced is NOT killed**; the coverage
hypothesis holds strongly enough to justify building/populating the CEGE graph and re-running
this exact spike against the real graph (swap the MusicBrainz proxy for CEGE presence + graph
degree/path checks; the script is structured for that substitution).

## Artifacts

- [`eval/spikes/cege_coverage.py`](../eval/spikes/cege_coverage.py) — the spike (reproducible).
- `eval/spikes/missed_set.json` — the reconstructed 2,709-artist missed set + CEGE data state.
- `eval/spikes/mb_coverage.json` — per-artist MusicBrainz presence/degree + the verdict block.
- `eval/spikes/.mbcache/` — raw MB responses (git-ignored; regenerable).

## Sources

- MusicBrainz web service (search + `inc=artist-rels`): <https://musicbrainz.org/doc/MusicBrainz_API>
- MusicBrainz rate-limit / User-Agent policy: <https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting>
- Kill criterion + F8 spec: [`docs/roadmap-10x-2026-07-02.md`](roadmap-10x-2026-07-02.md),
  [`docs/phase0-tasks-2026-07-03.md`](phase0-tasks-2026-07-03.md).
