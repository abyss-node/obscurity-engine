# Getting started: find your next favorite artist

By the end of this you'll have run a discovery on your own Last.fm history,
read the obscurity map, and opened a deep-cut artist you've never heard. About
five minutes.

## What you'll need

- A [Last.fm](https://www.last.fm) account with some listening history. If
  you don't scrobble yet, see [the bottom of this guide](#no-listening-history-yet).
- Nothing to install — use the hosted app at
  [obscurity-engine.vercel.app](https://obscurity-engine.vercel.app). (To run
  it yourself, see [howto-run-locally.md](howto-run-locally.md).)

## Step 1: Run a discovery

Open the app and type your Last.fm username, then press Enter.

The scan takes 30–45 seconds the first time — it's reading your top artists,
expanding each into its similar-artist neighbourhood, and cross-checking
against your genres. You'll see a loading state while it works. (Run it again
later and it's instant, from cache.)

## Step 2: Read the obscurity index

The big number up top (0–100) is your **obscurity index** — how far below the
mainstream your results sit, weighted by how strongly each artist matches you.
Higher = deeper cuts. Next to it is a short read on your taste
("eclectic, death metal focus") and your active seed + candidate counts.

You've now got a real result. The rest is reading it.

## Step 3: Read the Discovery Matrix

The 2×2 plots your top 10 finds:

- **x-axis = conviction** — how strongly your taste points to them.
- **y-axis = stickiness** — how likely you are to stay.
- **dot size = obscurity** — bigger = more obscure.
- **gold dots = DUAL signal** — confirmed by both your similar-artist graph
  *and* your genres. These are the highest-confidence finds.

The quadrants: **KEEPERS** (top-right, love now + later), **GROWERS**
(top-left, slow burn), **QUICK HITS** (bottom-right, instant but may fade),
**WILDCARDS** (bottom-left, a gamble). Hover or tap a dot for its name.

## Step 4: Work the ledger

Below the matrix is the ranked list. Each row shows the artist, genre, country,
conviction, and listener count, with a gold ✦ on dual-signal finds.

- **Sort** by composite (default), conviction, stickiness, or listeners. Sort by
  **listeners ascending** to find the deepest cuts.
- **Click a row** to expand it: the score breakdown (with plain-English
  captions), the genres, the full **"recommended via"** list (which of your
  artists pointed here), and **listen / find** links — Last.fm, Spotify,
  Bandcamp.
- **"view more"** at the bottom reveals finds 11–25.

## Step 5: Open something new

Pick a gold dual-signal artist with low listeners, expand it, and hit
**Bandcamp** or **Spotify**. That's the payoff — an artist your taste genuinely
points to that almost nobody has found yet.

## Step 6: Switch time windows

The top bar period selector changes what "your taste" means:

- **MIX** (default) — all your history, weighted toward recent listening. Best
  general picture.
- **7D / 1M / 3M …** — a specific window. Use a short window to discover from a
  recent phase; use **ALL** for your all-time taste.

Each window recomputes from a different slice of your history, so the results —
and which artists earn the dual-signal — genuinely change.

## What you built

You ran your listening history through the discovery pipeline, read your
obscurity index and discovery map, and surfaced under-the-radar artists matched
to your taste. To understand *why* an artist ranked where it did, read
[explanation-scoring.md](explanation-scoring.md). To share a result, use the
"↑ share" control (it exports a card image).

## No listening history yet?

The app needs a few days of scrobbles (~50 plays) to read your taste. Connect
scrobbling and come back:

- **Spotify:** last.fm → Settings → Applications → connect Spotify.
- **Android:** Pano Scrobbler.
- **Desktop / web:** Web Scrobbler browser extension.

The app's onboarding guide walks through these. Until then you'll see an
"account found · 0 scrobbles" state.

## Related

- [explanation-how-it-works.md](explanation-how-it-works.md) — what happens during the scan
- [explanation-scoring.md](explanation-scoring.md) — how the ranking is decided
