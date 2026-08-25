# Eval — offline harness (Python)

You own `eval/`. **This lane ships nothing.** It never writes to `backend/` or
`frontend/`. A win here becomes a Rust change made by a backend session, after
you have stated the result and stopped.

It exists so "is the scoring better?" is a number rather than a vibe, and because
the scoring brain is kept in Python — the language CEGE uses — so an improvement
is portable rather than trapped in Rust.

## Non-negotiable

**The future must never leak into the past.** Seeds are reconstructed from
`user.getRecentTracks` up to a cutoff, giving a true point-in-time snapshot; a
recommendation counts as a hit only if the artist was adopted in the holdout
window and was not known before the cutoff. Any change that touches cohort
building, seeding or the cutoff has to preserve that, and a leak makes every
number in the run meaningless rather than merely optimistic.

**Metrics are relative, never absolute.** Absolute recall is low because people
find music from many sources that this harness cannot see. Report A-versus-B.
Never quote a bare recall figure as a result — it will be read as a score.

**`obscurity_weighted@k` is the metric that tracks the product goal.** A variant
that lifts raw hits while flattening obscurity weighting is not a win.

**A difference is not a result until it survives a paired bootstrap at a real
n.** On 2026-06-22 a re-run at n=348 reversed conclusions drawn at n=54: the
shipped underexplored multiplier became significant, while adaptive and temporal
variants turned significantly *negative*. Use `lb_paired_bootstrap.py`, report
the interval, and state n every time.

**Say when the result is null.** Most variants tested here have been honest
losses, and discovery hits have been flat at roughly 78 across every multiplier —
that flatness is itself the finding that reach is data-capped. A harness that
only ever reports wins is broken.

## Reproducibility

Runs are JSON artefacts in this directory, named for the variant and the cohort
size (`blend_n348.json`, `blend_n348_anchor_2026-06-10.json`). Keep that
convention: a result with no recorded n and no anchor date cannot be compared to
anything later.

The anchor date matters as much as n. Merging runs across anchors goes through
`merge_anchor_runs.py`, never by hand.

## Python

`requirements.txt`, no lock file, no linter, no test runner. There is nothing
mechanical guarding this lane, which makes the discipline above the whole of the
safety net. If this lane becomes active again, a linter and a lock file are the
first two things worth adding.

## Commands

| Task | Command |
|---|---|
| Install | `cd eval; pip install -r requirements.txt` |
| Baseline run | `cd eval; python harness.py --cohort cohort.txt --json baseline.json` |
| A/B a variant | `cd eval; python harness.py --cohort cohort.txt --use-<variant> --json <variant>.json` |
| Significance | `cd eval; python lb_paired_bootstrap.py baseline.json <variant>.json` |
| Build a cohort | `cd eval; python build_cohort.py` |

Name which of these you ran and which you only reasoned about — and state n.
