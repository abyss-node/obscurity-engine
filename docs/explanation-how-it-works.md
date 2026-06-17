# How the Obscurity Engine works

This is the end-to-end explanation of what happens between typing a Last.fm
username and seeing a ranked list of obscure artists. If you want the precise
field-by-field API, see [reference-api.md](reference-api.md). If you want the
scoring math, see [explanation-scoring.md](explanation-scoring.md).

## The problem it solves

Mainstream recommenders optimize for the safe next play: the popular artist
most people like you also like. That surfaces what you'd have found anyway.
The Obscurity Engine does the opposite — it looks for artists that your taste
genuinely points to but that **haven't broken through yet** (under a 25,000
listener ceiling), and that you **haven't already heard**.

It runs entirely on the public Last.fm API. There is no database and no model
training — the "intelligence" is a deterministic pipeline over Last.fm's
similar-artist graph and genre folksonomy.

## The pipeline at a glance

```
username + period
       │
       ▼
┌─────────────┐   user.gettopartists (×6 windows for MIX, or ×1)
│ 1. SEEDS    │   → your most-played artists, recency-weighted
└─────────────┘
       │  seed names + weights
       ▼
┌─────────────┐   user.getinfo → lifetime mean plays-per-artist
│  THRESHOLD  │   = the "underexplored" line (what counts as already-heard)
└─────────────┘
       │
       ├───────────────────────────────┐
       ▼                                ▼
┌─────────────┐                  ┌─────────────┐
│ 2. TAG GRAPH│  artist.getinfo  │ 3. CANDIDATES│ artist.getsimilar
│  (genre)    │  + tag.gettop... │  (similarity)│ ×20 per seed
└─────────────┘                  └─────────────┘
   cross-validation set            candidate → recommenders map
       │                                │
       └───────────────┬────────────────┘
                       ▼
              ┌──────────────────┐  artist.getinfo per candidate
              │  4. SCORING      │  conviction × stickiness × genre fit
              │  filter→rank→    │  cross-validation bonus, diversity,
              │  diversify→depth │  obscurity index
              └──────────────────┘
                       │
                       ▼
            up to 25 ranked artists + obscurity index
```

The orchestration lives in `backend/src/pipeline/mod.rs`
(`discover_obscure_artists`). Each stage is a separate file under
`backend/src/pipeline/`.

## Stage 1 — Seeds (`seeds.rs`)

Seeds are the artists your discovery radiates out from: your most-played
artists. How they're gathered depends on the period:

- **Single period** (`7day`, `1month`, `3month`, `6month`, `12month`,
  `overall`): one `user.gettopartists` call. Each artist's weight is
  `log2(playcount)` — log-compressed so a 10,000-play favorite doesn't drown
  out a 100-play one.
- **MIX / blend** (the default): all six windows are fetched in parallel and
  merged. Each window is normalized to a **plays-per-week rate** (the 7-day
  window counts ×1.0, all-time counts ×0.0064) so recent listening dominates
  without the years-deep "overall" window flattening everything. This is what
  makes MIX track your *current* taste, not your all-time taste.

The top 100 seeds (by blended weight) move forward. The full math is in
[explanation-scoring.md](explanation-scoring.md#seed-weighting).

## The "underexplored" threshold

Before discovery runs, the engine computes one number per user: the **lifetime
mean plays-per-artist** (`total scrobbles ÷ distinct artists`, from
`user.getinfo`). This is the line between "heard in passing" and "dug into."

- Artists you've played **fewer** times than this threshold (including never)
  are recommendable.
- Artists you've played **more** are excluded as already-known.

This is the *underexplored novelty model*. It means a band you scrobbled twice
years ago can resurface as a recommendation (and re-engaging with it counts as
a successful discovery), while your daily-rotation favorites never clutter the
results. If `user.getinfo` is unavailable, the engine falls back to **strict**
mode: exclude any artist you've ever played.

## Stage 2 — Tag graph (`tag_graph.rs`)

This builds a **second, independent signal** so a recommendation can be
confirmed by more than one path.

1. Take your top 15 seeds, fetch each one's genre tags (`artist.getinfo`),
   and tally them. The 3 most common tags become your **derived genres**.
2. For each derived genre, fetch the top 100 artists on Last.fm
   (`tag.gettopartists`).

The union of those artists is the **cross-validation set**. It also builds a
**seed-genre profile** — a weighted map of all your genre tags — used both for
genre-fit scoring and for popularity-neutral cross-validation (see
[scoring](explanation-scoring.md#cross-validation-the-dual-signal)).

## Stage 3 — Candidates (`candidates.rs`)

For each seed, the engine fetches Last.fm's 20 most similar artists
(`artist.getsimilar`, 8 concurrent, small jitter to be polite to the API).
Every similar artist becomes a **candidate**, and the engine records **which
seeds pointed to it**. A candidate that shows up via five different seeds
carries five "recommenders" — the raw material for conviction.

## Stage 4 — Scoring (`scoring.rs`)

This is where candidates become a ranked list:

1. **Pre-filter** to the top 600 candidates by recommender count (keeps the
   expensive info-fetch bounded).
2. **Fetch `artist.getinfo`** for each (12 concurrent; results cached 24h).
3. **Filter out:** artists over the 25K listener ceiling, your own seeds,
   already-heard artists (per the threshold), and collaborations where any
   member is over the ceiling.
4. **Score** each survivor: `conviction × stickiness`, plus a cross-validation
   bonus and a genre-fit uplift. (Definitions in
   [explanation-scoring.md](explanation-scoring.md).)
5. **Diversify:** keep at most 3 artists per primary genre so one subgenre
   can't dominate.
6. **Cap at 25** and compute the **obscurity index** over the top 10.

## What you get back

A ranked list of up to 25 artists, each with conviction, stickiness, composite,
listener count, genres, the seeds that pointed to it, a dual-signal flag,
re-engagement flag, and listen/find links. Plus the obscurity index (0–100),
your top genres, and the active seed count. The exact schema is in
[reference-api.md](reference-api.md).

## Determinism (why prod and local agree)

Every fan-out stage is **fail-closed**: if any Last.fm call fails transiently
(rate-limit Error 29, 5xx, network drop after retries), the whole request fails
with a retry message rather than silently shipping a thinner result. This is
deliberate — a half-complete candidate pool would make the same user get
different results on different runs. Permanent failures (an artist Last.fm
simply has no data for) are skipped deterministically. Every sort that feeds a
truncation has a name tiebreaker. The result: same user + same Last.fm data →
identical output, every time.

## Track mode

There is a parallel **track** pipeline (`track_seeds.rs`,
`track_candidates.rs`, `track_scoring.rs`) that discovers obscure *tracks*
instead of artists. It's wired and functional but currently gated behind a
"Coming soon" overlay in the UI. See [roadmap.md](roadmap.md).

## Related

- [explanation-scoring.md](explanation-scoring.md) — the scoring math and the obscurity model
- [reference-api.md](reference-api.md) — the HTTP API and response schema
- [reference-eval-harness.md](reference-eval-harness.md) — how scoring changes are measured before shipping
