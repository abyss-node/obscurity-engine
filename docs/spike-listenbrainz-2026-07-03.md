# Spike T-C — ListenBrainz candidate-source A/B (Phase 0 de-risking)

**Date:** 2026-07-03
**Verdict:** **DIRECTIONAL NO-GO for `listenbrainz`-only, DIRECTIONAL GO for `blend`** —
single anchor, n=54; see caveats. `listenbrainz` alone collapses reach (the
harness's primary discovery metric) by ~83% relative to the shipped Last.fm
baseline. `blend` (Last.fm + ListenBrainz candidates merged) is the only arm
that beats baseline reach with a CI that excludes zero, at a real but small
MRR/discovery-hits cost that doesn't reach significance either way.

---

## Question

Does swapping (or supplementing) the Last.fm similar-artists graph with
ListenBrainz's `session_based` collaborative-filtering endpoint change
discovery quality — specifically **reach**, **pure-discovery hits**,
**obscurity-weighted@k**, and **MRR** — on the de-biased eval cohort?

---

## Method

**Lever added** (`eval/config.py`, additive/default-off):
`candidate_source: Literal["lastfm", "listenbrainz", "blend"] = "lastfm"`.
Dispatch lives in `eval/pipeline.py::build_candidates` (lines ~204-220):
`"lastfm"` (default) is byte-identical to the pre-existing code path
(`_build_candidates_lastfm`, untouched); `"listenbrainz"` and `"blend"`
delegate to the new `eval/listenbrainz.py` and are unreachable unless the
lever is explicitly flipped off its default.

**ListenBrainz client** (`eval/listenbrainz.py`):
- Endpoint: `labs.api.listenbrainz.org/similar-artists/json`, algorithm
  `session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30`
  (the enum is strict server-side; a 400 response lists valid values — this
  one was verified live).
- **MBID resolution** (two-tier, per seed artist name): Tier 1 — reuse
  Last.fm's own `artist.getinfo` `mbid` field (free, already fetched from the
  warm Last.fm cache). Tier 2 (only on a Tier-1 miss) — MusicBrainz artist
  search (`ws/2/artist?query=...`), accepting only a top hit with search
  score >= 80 to avoid attaching the wrong artist. Both tiers are memoized
  in-process and sqlite-cached (`eval/.cache/listenbrainz.sqlite`) exactly
  like the Last.fm client, with a ~1 req/s per-host limiter and a descriptive
  User-Agent, per ListenBrainz/MusicBrainz access policy.
- **Score normalization:** LB's `score` is an unbounded raw collaborative-
  filtering count, not a 0-1 similarity like Last.fm's `match`. Normalized
  per-seed by dividing by that seed's max score, matching the scale the
  harness's downstream weighting expects.
- **`blend`:** runs the unmodified Last.fm candidate build and the
  ListenBrainz candidate build in parallel for the same seed set, then
  `merge_candidate_maps` unions the two candidate pools per artist (summing
  per-seed match contributions), so an artist surfaced by either graph enters
  scoring.

**Runs** (de-biased cohort, single anchor `2026-06-10`, same config as the
shipped baseline artifact — `--threshold flat --novelty-model underexplored
--xval-genre-overlap`, `k=20`):

```
python -u harness.py --users "<60-user cohort csv>" --anchor 2026-06-10 \
  --threshold flat --novelty-model underexplored --xval-genre-overlap \
  --candidate-source listenbrainz --json eval/lb_debiased_n54.json

python -u harness.py --users "<60-user cohort csv>" --anchor 2026-06-10 \
  --threshold flat --novelty-model underexplored --xval-genre-overlap \
  --candidate-source blend --json eval/blend_debiased_n54.json
```

60 users requested, 54 non-skipped/evaluable per run (6 skipped for thin
past history / no new adopted artists in the holdout window — same 6 as the
baseline run, so the paired comparison below is over the identical 54-user
set with no cohort drift).

**Default-safety check** (proof the lever is additive-only): the same 60-user
cohort re-run with `--candidate-source` **omitted** (defaults to `"lastfm"`)
reproduces `eval/under_flat_debiased_n60.json` exactly — **0 diffs across 19
aggregate keys and all 54 per-user metric rows**. `git diff` on `main` shows
only new code paths (`listenbrainz.py`, the `build_candidates` dispatch, the
new config field default `"lastfm"`); no existing scoring code changed.

**Comparison:** paired bootstrap (`eval/lb_paired_bootstrap.py`, 5,000
resamples, seed 12345) of each arm's per-user metric deltas against the same
54 users in the baseline artifact `eval/under_flat_debiased_n60.json` — the
harness's own standard A/B method used throughout the rec-algo investigation.

---

## Results

### Headline metrics (mean over the paired n=54; 95% bootstrap CI on the paired diff)

| metric | lastfm (baseline) | listenbrainz | blend |
|---|---|---|---|
| **reach** | 0.0458 | **0.0080** (diff −0.0378, CI [−0.0604, −0.0198] — excludes 0) | **0.0523** (diff +0.0066, CI [+0.0009, +0.0143] — excludes 0) |
| pure-discovery hits (mean/user) | 0.2407 | 0.1481 (diff −0.0926, CI [−0.2778, +0.0741] — n.s.) | 0.2778 (diff +0.0370, CI [−0.0556, +0.1296] — n.s.) |
| obscW@k | 0.0094 | 0.0109 (diff +0.0015, CI [−0.0050, +0.0078] — n.s.) | 0.0104 (diff +0.0010, CI [−0.0031, +0.0051] — n.s.) |
| MRR | 0.1254 | 0.1906 (diff +0.0653, CI [−0.0472, +0.1798] — n.s.) | 0.1730 (diff +0.0477, CI [−0.0259, +0.1296] — n.s.) |
| hits (any) | 0.4444 | 0.3889 (diff −0.0556, n.s.) | 0.4444 (diff +0.0000, n.s.) |
| recall@k | 0.0182 | 0.0263 (diff +0.0082, n.s.) | 0.0208 (diff +0.0026, n.s.) |

Only **reach** clears statistical significance in either direction, in both
arms: `listenbrainz` alone loses ~83% of baseline reach (CI excludes 0,
clearly negative); `blend` gains ~14% over baseline reach (CI excludes 0,
positive but modest). Every other headline metric (discovery hits, obscW@k,
MRR) moves within noise at this n — directionally MRR and obscW@k both look
*better* for listenbrainz/blend than lastfm, but the CIs straddle zero, so
that cannot be called from a single 54-user anchor.

### MBID resolution miss-rate (identical for both LB-using arms — same seed set)

| quantity | value |
|---|---|
| seeds attempted | 2,445 |
| resolved via Last.fm `mbid` field (Tier 1) | 2,069 (84.6%) |
| resolved via MusicBrainz search, score>=80 (Tier 2) | 198 (8.1%) |
| **unresolved (no candidates fetched for that seed)** | **178 (7.3%)** |
| `similar-artists` calls made | 3,056 |
| calls returning an empty candidate list | 462 (15.1% of calls) |

7.3% of seed artists never enter the ListenBrainz candidate pool at all
(couldn't be resolved to an MBID with confidence), and another 15% of
resolved calls come back empty (LB's session-based model has no
collaborative signal for that artist — expected for very small artists,
since the underlying algorithm requires session co-occurrence in
ListenBrainz's own scrobble corpus). Both are structural gaps in LB
coverage, not implementation bugs — a session-based CF model over a much
smaller listener base than Last.fm will always have thinner tail coverage.

---

## Interpretation

- **Reach is the metric that matters most here** (it is the harness's
  primary "did we surface something the user actually went on to adopt"
  signal), and it moves the most and most clearly. `listenbrainz`-only
  candidates reach roughly a fifth of what the Last.fm graph reaches on the
  same cohort — consistent with the resolution miss-rate (7.3% of seeds
  contribute nothing) plus LB's much smaller/sparser underlying corpus versus
  Last.fm's, which directly shrinks the surfaced-candidate pool and thus the
  chance any of it lands in a user's actual holdout adoptions.
- **`blend` recovers and slightly exceeds baseline reach.** Because `blend`
  unions Last.fm's full candidate pool with whatever ListenBrainz adds, it
  can only ever match or beat Last.fm-only reach on the same
  seeds — the CI-excludes-zero gain (+0.0066, ~14% relative) says
  ListenBrainz is finding *some* real adoptions Last.fm's own graph misses,
  which is the CEGE-coverage hypothesis (T-B) playing out with a live,
  already-populated alternative graph rather than a proxy.
- **MRR and discovery-hits move in ListenBrainz's favor directionally but
  aren't significant at n=54, single anchor.** A larger cohort and/or
  multi-anchor run (the harness's `--anchors` flag exists for this) would be
  needed to resolve whether ListenBrainz-sourced candidates rank better when
  they do land, or whether that's sampling noise from six additional users
  disagreeing between listenbrainz and blend runs on marginal hit/no-hit
  boundary cases.
- **Cost/complexity is non-trivial and ongoing:** a second external API,
  1 req/s budget, a two-tier MBID resolver with its own cache, and 7.3%
  structural resolution loss. `blend` pays that cost on every request (both
  APIs called) for a reach gain that, while statistically real, is modest in
  absolute terms (+0.0066 mean reach, i.e. roughly one additional reached
  adoption per ~150 eligible artist-opportunities).

## Verdict

**`listenbrainz`-only: DIRECTIONAL NO-GO.** It measurably and significantly
reduces reach versus the shipped Last.fm baseline at this n; nothing else it
gains is statistically distinguishable from noise. Do not ship as a
replacement candidate source.

**`blend`: DIRECTIONAL GO, worth a bigger validation pass.** It is the only
arm with a significant *positive* effect on the primary metric (reach), with
no significant loss on anything else, which mirrors the T-B CEGE-coverage
spike's finding that Last.fm's graph structurally misses adopted artists that
other sources can reach. Given this is **single-anchor, n=54** — the same
caveat every other threshold/lever experiment in this codebase carries before
its high-power re-validation — the recommended next step (if Phase 3 revisits
candidate sourcing) is the same multi-anchor / n>=120 paired-bootstrap
re-validation the rec-algo investigation used for the mult-ladder and
xval-genre-overlap findings, not a direct ship decision from this spike
alone.

---

## Artifacts

- `eval/listenbrainz.py` — the ListenBrainz client (MBID resolution, sqlite
  cache, candidate build, `merge_candidate_maps`).
- `eval/config.py`, `eval/pipeline.py` — the additive `candidate_source`
  lever + dispatch (default `"lastfm"`, unchanged behavior).
- `eval/lb_debiased_n54.json` — full harness output, `--candidate-source
  listenbrainz`, same cohort/anchor as the baseline.
- `eval/blend_debiased_n54.json` — full harness output, `--candidate-source
  blend`.
- `eval/lb_paired_bootstrap.py` — the paired-bootstrap comparison script used
  above (reusable: `python lb_paired_bootstrap.py baseline.json variant.json
  label`).
- Baseline: `eval/under_flat_debiased_n60.json` (pre-existing, unchanged).

## Sources

- ListenBrainz labs similar-artists API:
  <https://listenbrainz.org/data/> / `labs.api.listenbrainz.org`
  (algorithm enum verified live via 400-response error listing).
- MusicBrainz search API (Tier-2 MBID resolution) and rate-limit policy:
  <https://musicbrainz.org/doc/MusicBrainz_API>,
  <https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting>.
- Task spec: [`docs/phase0-tasks-2026-07-03.md`](phase0-tasks-2026-07-03.md)
  (T-C section + Ground rules).
