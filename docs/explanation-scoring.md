# The scoring model

This explains *why* a given artist ranks where it does, and the design choices
behind each signal. For the pipeline overview see
[explanation-how-it-works.md](explanation-how-it-works.md). Every constant named
here lives at the top of `backend/src/pipeline/scoring.rs` unless noted.

## The goal

Rank artists by **how strongly your taste points to them** and **how likely
you are to stick with them**, while keeping everything **obscure** (under
25,000 listeners) and **new to you**. Three signals combine into one composite
score.

## Seed weighting

A seed's weight measures how much it represents your taste.

- Single period: `weight = log2(playcount)`.
- MIX: each of the six windows contributes `log2(playcount) × (7 / window_days)`,
  summed. The per-week normalization (7day ×1.0 → overall ×0.0064) makes recent
  listening dominate. `log2` keeps a 5,000-play artist from being 50× a
  100-play artist — it's ~1.7×.

These weights flow into conviction (a candidate inherits the weight of the
seeds that recommended it).

## Conviction

> How strongly your seeds point to this candidate.

For each candidate, sum the weights of every seed that listed it as similar,
with each seed's contribution capped at `CONVICTION_CAP = 3.0` (so one
mega-played seed can't single-handedly carry a candidate). More independent
seeds pointing to the same artist = higher conviction. This is collaborative
filtering: agreement across different parts of your taste is the signal.

## Stickiness

> Whether the people who find this artist stay.

`stickiness = monthly listeners ÷ total listeners`. A high ratio means a small
but **active, returning** fanbase — the hallmark of an artist worth following,
not a one-hit blip. A huge artist with millions of passive listeners scores
low here; a cult artist whose listeners keep coming back scores high.

## Composite

`composite = (conviction × 100) × stickiness`, then multiplied by a genre-fit
uplift (below). This is the default sort. It balances "your taste points here"
against "this fanbase is real."

## Genre fit (taste alignment)

> How much this artist's genres overlap your overall taste.

The engine builds a **seed-genre profile** from your top 40 seeds (each
contributes its top 5 tags, weighted by the seed's weight, normalized so your
top genre = 1.0). A candidate's taste-alignment is the summed profile weight of
its own tags. The composite is then nudged: `composite × (1 + 0.5 × alignment)`.
An artist dead-center in your taste gets up to a 50% boost; an off-genre
curiosity gets none.

## Cross-validation (the DUAL signal)

> A second, independent confirmation beyond the similar-artist graph.

A candidate is **dual-signal** (gold ✦ badge, +0.5 conviction bonus) when it's
confirmed by genre as well as similarity. There are two ways to earn it:

1. **Tag-graph membership** — the artist appears in the top-100 of one of your
   derived genres (`tag.gettopartists`).
2. **Genre overlap** — at least 3 of the artist's own tags carry real weight
   (≥ 0.15) in your seed-genre profile.

### Why two ways (the de-biasing story)

Path 1 alone is **popularity-biased**: `tag.gettopartists` ranks by popularity,
so the top 100 of a broad genre like "death metal" is all famous bands. The
obscure artists this app exists to surface rank #300–700 in that list and never
appeared — they could only get the badge when a *narrow* subgenre tag happened
to be derived. Measured directly: a 24K-listener band sits at #42 in "brutal
death metal" but #661 in "death metal."

Path 2 fixes this. An obscure band self-tagged "brutal death metal" overlaps
your profile **regardless of how famous it is**. It reuses tags already
fetched during scoring, so it costs zero extra API calls.

This change was validated in the eval harness before shipping (see
[reference-eval-harness.md](reference-eval-harness.md)): dual-signal coverage
went from ~0.3 to ~3 artists per user, those dual-signals started correlating
with real adoptions (0 → 0.27 per user), and precision/recall/obscurity were
unchanged. Constants: `XVAL_OVERLAP_MIN_TAGS = 3`, `XVAL_OVERLAP_MIN_WEIGHT = 0.15`.

## The obscurity gate

Two filters keep results genuinely obscure:

- **Hard ceiling:** any artist over `MAX_LISTENER_CEILING = 25,000` listeners is
  dropped.
- **Collaboration guard:** for joint names ("Artist A & Artist B"), each member
  is checked individually — a collab can have few listeners while its members
  are famous, which would sneak a star past the ceiling.

## Novelty model (underexplored)

The threshold for "already heard" is your **lifetime mean plays-per-artist**
(`UNDEREXPLORED_MULT = 1.0`, in `pipeline/mod.rs`). Below it → recommendable;
at or above → excluded. This surfaces lightly-played artists for re-engagement
(flagged `reengagement: true`) instead of hiding everything you've ever
touched. The eval harness confirmed `1.0` beats `0.5` (lowering it only lost
hits). Falls back to **strict** (exclude anything ever played) if Last.fm
doesn't return the counts.

## Diversity

`DIVERSITY_SLOTS_PER_GENRE = 3`: at most 3 artists per primary genre survive to
the final list, so a single subgenre can't fill all 25 slots. Applied after
ranking, before the cap.

## The obscurity index (depth score)

The headline 0–100 number. It's the **conviction-weighted average obscurity**
of the results, where one artist's obscurity is `sqrt(1 − listeners / 25,000)`.
The square root makes the scale perceptually linear:

| Listeners | Obscurity |
|---|---|
| 0 | 100 |
| 5,000 | 89 |
| 10,000 | 78 |
| 20,000 | 45 |
| 25,000 | 0 |

It's computed over the **default top 10** (`DEFAULT_SHOWN = 10`), not all 25,
so the headline stays stable whether or not you click "view more".

## Constants quick-reference

| Constant | Value | Meaning |
|---|---|---|
| `MAX_LISTENER_CEILING` | 25,000 | obscurity gate |
| `CONVICTION_CAP` | 3.0 | per-seed conviction ceiling |
| `CROSS_VALIDATION_BONUS` | 0.5 | dual-signal conviction bonus |
| `XVAL_OVERLAP_MIN_TAGS` | 3 | tags needed for genre-overlap dual-signal |
| `XVAL_OVERLAP_MIN_WEIGHT` | 0.15 | min profile weight per overlapping tag |
| `DIVERSITY_SLOTS_PER_GENRE` | 3 | max artists per genre |
| `MAX_RECOMMENDATIONS` | 25 | hard cap on results |
| `DEFAULT_SHOWN` | 10 | default visible rows / obscurity-index window |
| `MAX_CANDIDATES_FOR_INFO_FETCH` | 600 | pre-filter cap before info fetch |
| `SIMILAR_ARTISTS_PER_SEED` | 20 | similar artists fetched per seed |
| `TAGS_TO_DERIVE` | 3 | genres derived for the tag graph |
| `TAG_ARTISTS_LIMIT` | 100 | top artists fetched per derived genre |
| `UNDEREXPLORED_MULT` | 1.0 | threshold multiplier (in `mod.rs`) |

## Related

- [explanation-how-it-works.md](explanation-how-it-works.md) — the pipeline these signals live in
- [reference-eval-harness.md](reference-eval-harness.md) — how these weights are measured and A/B'd
- [reference-api.md](reference-api.md) — where each score appears in the response
