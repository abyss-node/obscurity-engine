# Obscurity Engine — offline eval harness

Python port of the discovery pipeline plus a **temporal-holdout evaluator**, so
"is the scoring better?" becomes a number instead of a vibe. This is also where
the scoring brain lives in Python — the language CEGE uses — so improvements made
here are portable into CEGE later instead of being trapped in Rust.

## The idea

For each user, split their listening history at a cutoff:

```
[ ──── past (seeds) ──── | ──── holdout (ground truth) ──── ]
 cutoff-365d          cutoff                            anchor (now)
```

- **Seeds** are reconstructed from `user.getRecentTracks` up to the cutoff — a
  true point-in-time snapshot, so the future can't leak in.
- Run the pipeline on the past → ranked recommendations.
- A recommendation is a **hit** if the user *actually adopted* that artist in the
  holdout window (≥3 plays, not known before the cutoff).

The metrics are **relative** — compare variant A vs variant B. Absolute recall is
low because people discover music from many sources. The number that tracks the
product goal is `obscurity_weighted@k`: obscure hits count more than popular ones.

## Setup

```bash
cd obscurity-engine/eval
pip install -r requirements.txt          # aiohttp
# API key auto-loads from ../backend/.env, or set LASTFM_API_KEY
```

Edit `cohort.txt` with real usernames (your own + friends are the best signal).

## Run

```bash
python harness.py --cohort cohort.txt            # baseline (matches live Rust engine)
python harness.py --users you,friend --k 20
python harness.py --cohort cohort.txt --json baseline.json
```

First run pays the Last.fm API cost and caches every response to
`.cache/lastfm.sqlite`. After that, re-scoring is instant.

## A/B an improvement

The whole point. Baseline vs backlog item #1 (weight conviction by the
`getSimilar` match score, which the live engine currently discards):

```bash
python harness.py --cohort cohort.txt --json baseline.json
python harness.py --cohort cohort.txt --use-match-weight --json match.json
# compare obscurity_weighted@k and mrr between the two
```

New levers live in `config.py` as `Config` fields. Add a flag in `harness.py`,
flip it, re-run — the cache makes the second run free.

## Files

| file | role |
|------|------|
| `config.py`   | constants mirroring `scoring.rs` + experiment levers |
| `cache.py`    | SQLite response cache (makes iteration free) |
| `lastfm.py`   | async client, mirrors `lastfm.rs` + `getRecentTracks(from/to)` |
| `pipeline.py` | port of seeds → candidates → tag graph → scoring |
| `metrics.py`  | precision/recall/MRR/hit-rate + obscurity-weighted |
| `harness.py`  | temporal split, orchestration, report |

## Known approximations

- Listener counts come from `artist.getInfo` *now*, not as-of-cutoff (Last.fm
  exposes no history). Mild look-ahead bias; fine for relative comparison.
- Seeds use single-window log2(count), not the live 6-window blend.
- Genre tags use `artist.getInfo` for both signals (Rust uses `getTopTags` for
  the seed profile). Same signal, one fewer call.
```
