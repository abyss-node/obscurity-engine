# Eval harness reference

The offline eval harness (`eval/`) is how scoring changes are **measured before
they ship**. It's a faithful Python port of the Rust pipeline that scores
against real adoption data, so any ranking lever can be A/B'd on actual users
instead of eyeballed. This is the project's standing rule: scoring R&D happens
in Python (CEGE-portable, measurable), the Rust backend stays the serving edge.

## What it measures

A **temporal holdout**. For each user it:

1. Reconstructs seeds from `user.getRecentTracks` up to a cutoff date (the
   "past" window).
2. Runs the faithful pipeline port on those seeds.
3. Scores the recommendations against the artists the user **actually adopted**
   in the holdout window after the cutoff (≥3 plays, not known before).

So a "hit" is a recommendation the user really went on to listen to. Absolute
recall is low by nature (people discover music from many sources) — read the
numbers **relatively**, for comparing scoring variants.

## Running it

```bash
cd eval
pip install -r requirements.txt          # one-time
python harness.py --cohort cohort.txt    # uses backend/.env LASTFM_API_KEY
```

Common flags:

```bash
# match the live engine's defaults
python harness.py --cohort cohort.txt --novelty-model underexplored --threshold flat

# A/B a single lever
python harness.py --cohort cohort.txt --xval-genre-overlap --xval-overlap-min-tags 3

# write full per-user JSON
python harness.py --cohort cohort.txt --json out.json

# evaluate specific users instead of a cohort file
python harness.py --users alice,bob
```

First run on a cohort pays the Last.fm API cost; every re-run is **cache-fast**
(SQLite response cache at `eval/.cache/lastfm.sqlite`). Changing a lever that
needs new calls (e.g. a bigger `--tag-artists-limit`) re-fetches only the new
data.

## The metrics

Per user and aggregated (mean):

| Column | Meaning |
|---|---|
| `adopt` | artists the user adopted in the holdout |
| `elig` | adopted artists under the 25K ceiling (the reachable target) |
| `pool` | how many eligible adoptions the engine even surfaced (reach) |
| `hit` | adoptions that landed in the top-K |
| `R@k` / `P@k` | recall / precision at K |
| `MRR` | mean reciprocal rank of the first hit |
| `obsc@k` | **the product metric** — obscurity-weighted hit rate (rewards landing *obscure* adoptions) |
| `mean_lst` | mean listeners of the top-K |
| `xval` / `xvLst` / `xvHit` | dual-signals in top-K / their mean listeners / dual-signals that were adopted |

`obscurity_weighted@k` is the one that tracks the real goal: surfacing obscure
artists that actually land. The `xval*` columns were added to measure
cross-validation coverage and quality directly.

## The levers (Config)

All knobs live in `eval/config.py` as a `Config` dataclass; the defaults
**mirror the live Rust constants**, so an unmodified run reproduces production.
Each is a one-flip A/B. Key groups:

- **Pipeline shape:** `tags_to_derive`, `tags_per_seed_derive`,
  `tag_artists_limit`, `top_seeds_for_tags`, `max_candidates`, `max_seeds`.
- **Cross-validation de-biasing:** `xval_genre_overlap` (the popularity-neutral
  path), `xval_overlap_min_tags`, `xval_overlap_min_weight`.
- **Scoring:** `cross_validation_bonus`, `conviction_cap`, `ceiling`,
  `alignment_uplift`.
- **Threshold models:** `threshold_model` = `flat` (legacy 25K) | `true_fans`
  (per-user, devotion-aware) | `discovery` (soft per-user + obscurity bias).
- **Novelty:** `novelty_model` = `strict` | `underexplored`, `underexplored_mult`.
- **Backlog experiments (default off):** `use_match_weight`,
  `genre_relative_ceiling`, `two_hop`, `temporal_seed_weighting`.

## Worked example — the cross-validation de-biasing

This is the change that shipped most recently, and shows the workflow:

| Config | dual-signals/user | their mean listeners | adopted dual-signals | P@k | obsc@k |
|---|---|---|---|---|---|
| baseline (live) | 0.3 | — | 0.00 | .040 | .020 |
| more/specific tags + limit 500 | 1.7 | 6080 | 0.04 | .040 | .020 |
| **genre overlap ≥2** | 5.2 | 12090 | 0.35 | .040 | .020 |
| **genre overlap ≥3** | 3.0 | 9358 | 0.27 | .040 | .020 |

The genre-overlap lever (path 2 in [scoring](explanation-scoring.md#cross-validation-the-dual-signal))
took cross-validation from "fires for almost nobody, predicts zero adoptions"
to "fires for ~3/user, correlates with real adoptions" with no discovery
regression and no extra API calls. `≥3` shipped (more selective, more obscure
dual-signals). The wider-tag levers added API cost for little gain and were not
shipped.

## The cohort

`eval/cohort.txt` — one Last.fm username per line, `#` comments ignored. Good
cohorts use accounts with deep, active history through the holdout window. The
current cohort is small (~26 users) and somewhat bubbled (one friend cluster),
so treat results as **directional**. `eval/build_cohort.py` builds a de-biased
cohort from **multiple disconnected seed accounts** (snowball with per-root and
per-user caps) — running it with several unrelated seeds is the way to escape
the bubble.

## Files

| File | Role |
|---|---|
| `harness.py` | entrypoint, CLI, runs the cohort, prints + writes metrics |
| `pipeline.py` | faithful Python port of the Rust stages |
| `config.py` | the `Config` dataclass — every lever, defaults mirror Rust |
| `metrics.py` | hit/precision/recall/MRR/obscurity-weighted + xval diagnostics |
| `lastfm.py` | async Last.fm client |
| `cache.py` | SQLite response cache |
| `build_cohort.py` | de-biased multi-root cohort builder |

## Related

- [explanation-scoring.md](explanation-scoring.md) — the model the harness measures
- [explanation-how-it-works.md](explanation-how-it-works.md) — the pipeline it ports
