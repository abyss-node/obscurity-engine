<!-- /autoplan restore point: /c/Users/Arnuv'/.gstack/projects/abyss-node-obscurity-engine/main-autoplan-restore-20260606-160408.md -->
# Obscurity Engine — V2 Plan

## Problem Statement

The Obscurity Engine discovers artists a user hasn't heard yet but whose DNA matches
their listening history. The current v1 does this with a decent core algorithm but has
several correctness bugs, a hard-coded threshold that produces inconsistent results across
different library sizes, and a feature set that stops short of what the product concept
demands.

We want to fix the algorithm, unlock the features that are half-built, and add the
discovery analytics that would make this genuinely more useful than "random obscure band
generator."

---

## Current State Audit

### Bugs

**B1 — Period parameter ignored (critical)**  
`service.rs:18` immediately shadows `period_str` with `_period` and never uses it.
The frontend always passes `period=overall` but even if it sent `period=1month`, the
backend fetches Overall scrobble history regardless. The period picker the user expects
doesn't exist.

**B2 — CORS wildcard**  
`main.rs:86-88` sets `.allow_origin(Any)`. Any origin can call the API. Should be
restricted to `FRONTEND_URL` env var (already loaded, just not used in the CorsLayer).

**B3 — Errors return HTTP 200 with empty data**  
`discovery_handler:60-62` returns an empty DiscoveryResponse on any error. Frontend
has no way to distinguish "no results found" from "Last.fm rate-limited us." Should
return proper 4xx/5xx.

**B4 — IcebergVisual exists but is never rendered**  
`IcebergVisual.tsx` is fully implemented with floating nodes and depth mapping but is
not imported or used anywhere in `page.tsx`. Dead code with real value.

**B5 — `LASTFM_USERNAME` env var in render.yaml is unused**  
Declared as an env var but no code reads it. Confusing for anyone reading the config.

### Algorithm Weaknesses

**A1 — Hard 25,000 listener cap is genre-blind**  
An artist with 24,000 listeners in EDM (baseline: 100M) is not obscure. An artist with
24,000 listeners in microtonality or Hindustani classical is huge. The threshold should
be relative to genre baseline, not absolute.

**A2 — Stickiness formula is raw, not normalized**  
`stickiness = playcount / listeners`. This gives higher scores to artists whose fans
play them a lot globally, which correlates with cult status but also with playlist-heavy
artists. Needs normalization or a genre-relative baseline.

**A3 — Conviction can be dominated by one seed**  
If the user listens to Radiohead 5000 times and Radiohead's similar-artists includes
someone, that one recommender floods the conviction score. Should cap per-seed
contribution or use diminishing returns.

**A4 — No time weighting on seeds**  
Seeds collected from recent tracks are weighted identically to seeds from 5 years ago.
A user's current listening mood is more signal-rich for discovery than their 2019 phase.

**A5 — No diversity enforcement**  
Composite score can return 20 artists all tagged "post-rock." No genre deduplication
or diversity penalty.

**A6 — No taste-alignment signal**  
A discovered artist might be genuinely obscure but completely outside the user's taste
graph (wrong genre, wrong era). Adding a tag-overlap score between discovered artist
and the user's top genres would improve relevance.

---

## Proposed Changes

### Phase 1 — Bug Fixes + Algorithm Core (1-2 days)

**1.1 Fix period parameter**  
Wire `period_str` through `fetch_recent_tracks` and `fetch_user_top_artists`. Map string
to `TimePeriod` enum. Cache key already includes period (`reverse_scrobble:user:period`)
so caching works correctly once period is passed.

Last.fm supported periods: `overall`, `7day`, `1month`, `3month`, `6month`, `12month`.

**1.2 Fix CORS**  
Use `FRONTEND_URL` env var in CorsLayer instead of `Any`. Keep `Any` as fallback only
in local dev (when env var is absent).

**1.3 Fix error responses**  
Return `StatusCode::INTERNAL_SERVER_ERROR` + JSON error body on failure instead of
empty 200. Frontend can show "engine error, try again" instead of blank results.

**1.4 Genre-relative obscurity threshold**  
Replace the 25k hard cap with a soft score that rewards artists who are obscure
*relative to their genre peers*. Approach:

```
obscurity_score = log10(genre_median_listeners + 1) - log10(artist_listeners + 1)
```

Where `genre_median_listeners` is estimated from the top 3 tags' co-occurring artists
in the candidate pool. Obscurity > 0.5 (one order of magnitude below genre median) is
a meaningful signal. This requires no new API calls — we already have listener counts
for the full candidate pool.

**1.5 Time-weighted seeds**  
When collecting seeds from recent tracks, weight seeds discovered in the last 30 days
at 2x, last 90 days at 1.5x, older at 1.0x. Use `track.date` (already in the model)
to calculate age. Change `seed_weights: HashMap<String, f64>` to include this decay.

**1.6 Capped per-seed conviction**  
Cap any single seed's contribution to conviction at `min(weight, 3.0)`. Diminishing
returns past 3x prevents one dominant artist from flooding the ranking.

**1.7 Genre diversity enforcement**  
After scoring all candidates, apply a diversity pass: for each genre tag (top_tags[0]),
keep only the top 3 artists per tag in the final output. This doesn't change scores,
just the final `artists` list returned.

### Phase 2 — New Analytics Dimensions (2-3 days)

**2.1 Taste-alignment score**  
Compute tag overlap between discovered artist's `top_tags` and user's weighted genre
profile (derived from `top_genres` already calculated). Formula:

```
taste_alignment = sum(genre_weight[tag] for tag in artist.top_tags if tag in user_genres) / 5
```

Add `taste_alignment: f64` to `DiscoveryResponseItem`. Frontend can show this as
"Genre Fit" alongside Conviction and Stickiness.

**2.2 Personal Obscurity Depth Score**  
Compute a single 0-100 score per user run: the average obscurity_score across all
returned artists, weighted by composite_score. This is the headline number for the
profile — "Your Depth Score: 78/100."

Add to `DiscoveryResponse` as `depth_score: f64`.

**2.3 Velocity placeholder**  
Last.fm doesn't expose listener count growth rate. Add a `velocity: Option<f64>` field
(None for now) in the model, with a comment marking it as a future integration point
for a trend API (Kworb, Chartmetric, or Last.fm weekly comparison via two time-window
requests). This keeps the schema forward-compatible without new API calls in v2.

### Phase 3 — Frontend Features (2-3 days)

**3.1 IcebergVisual — wire it up**  
Add `<IcebergVisual artists={sortedArtists} />` to the results section in `page.tsx`
between PortfolioSummary and ArtistList. The component is complete; it just needs to
be rendered. Consider making it toggleable (default on, can hide).

**3.2 Period selector in UI**  
Add a `period` state and a picker (6 options: 7day, 1month, 3month, 6month, 12month,
overall) to the landing form or the results header. Pass it to the API call URL.
localStorage-persist the last-used period.

**3.3 Depth Score display**  
Show `depth_score` from the API response prominently in PortfolioSummary as the
headline stat. "DEPTH SCORE: 78 / 100" with a brief tooltip.

**3.4 Genre Fit badge on ArtistCard**  
Show `taste_alignment` as a badge inside the expanded card view. "GENRE FIT: 0.82"
styled like the existing Conviction/Stickiness metrics.

**3.5 Artist link improvement**  
Replace the YouTube Music search link in ArtistCard with a Last.fm artist page link
(`https://www.last.fm/music/{artist_name}`). Last.fm pages have bio, similar artists,
and listener stats — more useful for discovery than a YouTube search.

**3.6 Share button**  
Add a share button to the results header that generates a URL with `?u={username}&p={period}`.
On load, if these query params are present, auto-populate the username and trigger a fetch.
No backend changes needed — just a link.

### Phase 4 — Infrastructure (parallel with Phase 1-3)

**4.1 Remove unused LASTFM_USERNAME from render.yaml**  

**4.2 Redis/Upstash cache (optional but recommended)**  
The current in-memory `HashMap` cache dies on cold start. Replace with an optional
Upstash Redis cache: if `REDIS_URL` env var is set, use Redis; else fall back to the
existing in-memory cache. Use the `redis` crate. Cache key format unchanged.

This makes cold-start penalty a one-time event per deployment rather than per-server-restart.

---

## What We're NOT Building (Explicit Scope)

- Spotify integration (requires OAuth, significant scope increase)
- Multi-user social features (compare with friends) — needs auth layer
- Velocity signals from trend APIs (Chartmetric costs money; Kworb not reliable)
- "Save to playlist" (Spotify/Apple Music OAuth)
- Last.fm loved tracks exclusion (would need an additional API call per user)

These are good V3 features but would double the scope here.

---

## Open Questions

1. Should the genre-relative threshold (1.4) use median or 25th percentile of the
   candidate pool? Median is simpler; 25th percentile is more aggressive.
2. For the period selector (3.2), should changing the period auto-refresh, or should
   the user re-click "Execute Analysis"?
3. Should IcebergVisual (3.1) use `stickiness_score` for depth (current) or
   `total_listeners` (more intuitive — deeper = fewer listeners)?

---

## Implementation Order

```
Phase 1: B1 → B2 → B3 → A4 → A5 → A6 → A1+A2 together → A3
         + Redis/Upstash cache (moved from Phase 4 — see CEO review)
         + Scrobble quality indicator (new — see CEO review)
Phase 2: 2.1 → 2.2 → 2.3 (velocity stub)
         + Cross-validation bonus fix (flat additive +0.5, not 1.5x — see CEO review)
Phase 3: 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6
         + Share URL (3.6 promoted — core product loop per CEO review)
Phase 4: 4.1 (immediate), 4.2 (Redis already in Phase 1)
Phase 5: Dual-graph pipeline (was Phase 3 in design doc)
```

Total estimated CC effort: ~10-12 hours (Redis + reqwest upgrade + all fixes added). Human review/testing: ~3-4 hours.

---

## GSTACK REVIEW REPORT

<!-- AUTO-GENERATED by /autoplan -->

### Phase 1: CEO Review [subagent-only — Codex unavailable]

**Mode:** SELECTIVE EXPANSION
**Design doc:** found and read (Arnuv--main-design-20260606-161653.md)
**Premises confirmed by user:** all 5 (including P5: taste credentialing is the core emotional value)

#### 0A — Premise Challenge

| # | Premise | Status | Notes |
|---|---------|--------|-------|
| P1 | Last.fm similar-artists graph is popularity-biased hub-and-spoke | CONFIRMED | Root cause of niche blindness |
| P2 | Listener count = primary obscurity proxy | CONFIRMED | Global, stable metric |
| P3 | Cross-validation across two pipelines is stronger signal | CONFIRMED WITH FIX | Concept sound; 1.5× multiplier inverted (see Critical #1) |
| P4 | Conviction cap + time-weighting improve personal relevance | CONFIRMED | Fixes a real domination problem |
| P5 | Core emotional value = taste credentialing | CONFIRMED | Reorders frontend priority |

#### 0B — Existing Code Leverage Map

| Sub-problem | Existing code | Notes |
|------------|--------------|-------|
| Scrobble crawl | `fetch_recent_tracks` (lastfm.rs) | Reuse. Add period param (B1). |
| Similar artists | `fetch_similar_artists` (lastfm.rs) | Reuse. |
| Tag top artists | NEW `fetch_tag_top_artists` | ~30 LOC, same pattern |
| Conviction scoring | `service.rs` score loop | Add cap (A3) and time weighting (A4) |
| Top genres | Already computed in service.rs | Reuse as tag pipeline input |
| Cache | `HashMap<String, ...>` with RwLock | Replace with Redis or keep in-memory |
| IcebergVisual | `IcebergVisual.tsx` (fully implemented) | Just needs import in page.tsx |

#### 0C — Dream State Diagram

```
CURRENT (V1):
user → [scrobble history] → seed artists
        ↓
        similar_artists × N (popularity-biased)
        ↓
        filter by 25k absolute threshold (genre-blind)
        ↓
        composite_score = conviction × stickiness
        ↓
        results (period ignored, no sharing, IcebergVisual dead)

THIS PLAN (V2):
user → [scrobble history] → seed artists (time-weighted)
        ↓ (parallel)
        ┌─ similar_artists × N ────────────────────┐
        └─ tag_top_artists × M (top 5 genres) ─────┘
                ↓
                merge + dedup (case-insensitive normalize)
                ↓
                filter by genre-relative obscurity (log10)
                ↓
                score: conviction (capped) × stickiness + taste_alignment
                ↓
                cross-validation bonus: +0.5 to composite (flat, post-filter)
                ↓
                diversity pass (top 3 per genre tag)
                ↓
                results + period picker + IcebergVisual + share URL + depth score

12-MONTH IDEAL:
+ Scrobble quality indicator (sparse data warning)
+ Velocity signal (trend API or two time-window comparison)
+ Spotify OAuth fallback when Last.fm is unavailable
+ Social layer: compare depth scores between users
```

#### 0C-bis — Implementation Alternatives

| Approach | Effort | Risk | Key advantage | Key risk |
|---------|--------|------|--------------|---------|
| A: Scoring only (no dual-graph) | M / CC ~4h | Low | Ships faster, fewer API calls | Niche blindness unchanged |
| B: Tag-first (replace similar-artists) | L / CC ~8h | Med | Directly attacks popularity bias | Loses personal narrative |
| C: Dual-graph hybrid (chosen) | XL / CC ~10h | Med-High | Both signals, cross-validation | Higher complexity, more API calls |

**Chosen:** C. Cross-validation bonus fix reduces the risk.

#### 0D — CEO Findings + Auto-Decisions

**Critical #1: Cross-validation 1.5× multiplier is inverted**
Artists appearing in BOTH pipelines are better-connected nodes (moderately popular), not deeply niche. The 1.5× multiplicative bonus rewards popularity, not obscurity.
Auto-decided: FIX — change to flat additive +0.5 applied AFTER obscurity filtering. (P1 + P3)

**Critical #2: Redis cache is Phase 4 "optional" but existential for share loop**
Cold start → user clicks share URL → 15–75s wait → drops off. This kills the core product loop confirmed in P5.
Auto-decided: MOVE Redis to Phase 1. (P2)

**High #1: No scrobble quality indicator**
Users with <5000 scrobbles get results contaminated by artists they already know (pre-scrobble listening isn't captured). The worst first impression happens for the most growable user segment.
Auto-decided: ADD warning in frontend when `active_seed_count < 20`. One string, no backend work. (P5)

**High #2: Last.fm API fragility unaddressed**
No retry logic, no graceful degradation for silent API failures (200 with empty payload), no monitoring. B3 only fixes error codes, not silent failures.
Auto-decided: DEFER to TODOS.md. Can't fix the platform risk, but document it. (P3)

**TASTE DECISION #1: Share URL + Depth Score before dual-graph?**
CEO and P5 both argue social loop > algorithmic completeness. Share button is the product. Depth Score is the hook. Currently Phase 3 and Phase 2 respectively; dual-graph is Phase 5.
Surfaced at final gate.

#### 0E — Temporal Interrogation

| Milestone | What works | What might break |
|----------|-----------|-----------------|
| Hour 1 | B1-B3 fixed, period works end-to-end | Period cache key was already correct |
| Hour 4 | IcebergVisual renders, A1-A6 scoring improved | Genre median estimation from biased pool (see CEO P2) |
| Hour 8 | Share URL + Depth Score + Redis cache | Redis URL env var needs Upstash setup |
| Hour 16 | Dual-graph pipeline integrated | tag.getTopArtists candidate volume TBD (Open Q2) |
| Week 2 | Cross-validation bonus deployed | Tuning the +0.5 additive; may need A/B data |

#### 0F — Mode Confirmation
Mode: SELECTIVE EXPANSION. Scope held. Two additions approved (Redis to Phase 1, low-data warning). Dual-graph per design doc. Share URL priority surfaced as taste decision.

#### What Already Exists
- Seed collection: `service.rs` lines 45-120
- Similar artist fetching: `lastfm.rs` `fetch_similar_artists()`
- Conviction + stickiness scoring: `service.rs` scoring loop
- Top genres aggregation: `service.rs` tag count map (reuse as tag pipeline input)
- IcebergVisual component: `IcebergVisual.tsx` (complete, just needs import)
- Cache structure: `HashMap<String, (DiscoveryResponse, Instant)>` with RwLock
- Frontend theme/username persistence: localStorage keys already in page.tsx

#### NOT In Scope (CEO Phase)
- Spotify OAuth
- Multi-user social / friends comparison
- Trend velocity signals (Chartmetric, Kworb)
- Last.fm API resilience layer (acknowledged risk, deferred)
- Loved tracks exclusion
- Inward-facing "your discovery arc" feature (interesting V3 idea)

#### Error & Rescue Registry

| Error | Source | What user sees (V1) | What user sees (V2) | Priority |
|-------|--------|--------------------|--------------------|---------|
| Last.fm rate limit | `error_for_status()` | Empty results | HTTP 503 + "Rate limited, retry in 60s" | B3 |
| Last.fm silent failure (200 + empty) | No detection | Empty results | Empty results (unchanged — needs monitoring) | TODOS |
| Period param ignored | service.rs:18 | Wrong results silently | Period works | B1 |
| Cold start latency | Render free tier | Spinner → eventual results | Spinner → cache hit | Redis Phase 1 |
| Low scrobble data | No detection | Contaminated results | Warning banner | New |

#### Failure Modes Registry

| Failure | Probability | Impact | Mitigation |
|---------|------------|--------|-----------|
| Last.fm API change | Medium (12mo horizon) | Critical | TODOS.md |
| tag.getTopArtists returns only popular artists | High | Medium | Obscurity filter handles post-merge |
| Cross-validation bonus rewards hub artists | High | High | Fix to flat +0.5 additive post-filter |
| Render free tier cold start | High (every ~15min idle) | High | Redis cache Phase 1 |
| Genre median estimated from biased pool | Medium | Low-Medium | Acceptable approximation; note in code |

#### CEO Completion Summary

| Dimension | Score | Notes |
|-----------|-------|-------|
| Right problem | 8/10 | Yes, with P5 reframe: taste credentialing, not just discovery |
| Premises valid | 4/5 confirmed | P3 has implementation flaw (fixed) |
| Scope calibration | 7/10 | Redis priority fix improves significantly |
| Alternatives explored | 8/10 | 3 approaches considered; chosen approach defensible |
| Competitive risks | 5/10 | Last.fm platform risk is real and unaddressed |
| 6-month trajectory | 7/10 | With fixes, viable. Without Redis in Phase 1, broken. |

---

**PHASE 1 COMPLETE.** [subagent-only] Subagent: 5 findings (2 critical, 2 high, 1 taste). Consensus: 5/6 confirmed, 1 taste surfaced at gate. Passing to Phase 2 (Design Review).

---

### Phase 2: Design Review [subagent-only]

**UI scope:** YES (components, page.tsx, IcebergVisual, ArtistCard, period selector, badges)
**Design litmus scorecard:**

| Dimension | Score | Notes |
|-----------|-------|-------|
| Information hierarchy | 4/10 | IcebergVisual placement, Depth Score position, sort control position |
| Missing states | 3/10 | Period transition, empty per-period, error state, share URL conflict |
| User journey | 5/10 | No "hero" moment, no feedback loop, loading doesn't communicate progress |
| Specificity | 4/10 | Genre Fit layout, cross-validated field, period placement, share button CTA |
| New feature completeness | 4/10 | 3 of 7 features have critical gaps |

**Auto-decided fixes:**

| # | Fix | Principle |
|---|-----|-----------|
| D1 | IcebergVisual: render AFTER ArtistList (not before) | P5 |
| D2 | Period change: keep stale results + pulsing cyan border refresh indicator | P1+P5 |
| D3 | Add `error` state to page.tsx with `[ERR] SONAR_FAILURE` inline message + retry | P1 |
| D4 | `cross_validated: bool` field added to `Artist` interface in page.tsx | P5 |
| D5 | Genre Fit: third row `TASTE_MATCH: X%` above CTA in expanded card | P5 |
| D6 | Share URL: URL params > localStorage; loading from share URL does not overwrite user session | P5 |
| D7 | IcebergVisual X position: hash-seeded from artist name (not Math.random) | P5 |
| D8 | Last.fm artist URL: `https://www.last.fm/music/${encodeURIComponent(artist.name)}` | P5 |
| D9 | Depth Score: add `OBSCURITY_INDEX: [score] / 100` as hero number at top of results page | P5 |
| D10 | First-time UX: auto-trigger fetch when saved username exists in localStorage on mount | P5 |

**Taste decisions from Phase 2:**
- **TASTE #2:** Hero slot for rank #1 (full-width card vs uniform grid) — surfaced at gate
- **TASTE #3:** IcebergVisual: always-on vs collapsible toggle — surfaced at gate

**Not in scope (Design):**
- Dismiss/save feedback loop on artist cards (V3)
- Loading progress stages [01/04] INDEXING (good idea, deferred)
- Depth Score benchmarking against other users (no multi-user data in V2)

**PHASE 2 COMPLETE.** Subagent: 6 critical, 5 high, 3 medium, 2 taste decisions. All structural fixes auto-decided. 2 taste decisions surfaced at gate. Passing to Phase 3 (Eng Review).

---

### Phase 3: Engineering Review [subagent-only]

**Architecture ASCII Diagram — V2:**

```
              ┌──────────────────────────────────┐
              │         Axum Handler              │
              │  GET /api/discovery?u=X&p=Y       │
              └──────────────┬───────────────────┘
                             │ username validated (S1 fix)
                             │ period wired through (B1 fix)
                             ▼
              ┌──────────────────────────────────┐
              │          Cache Layer              │
              │  Redis (primary) → in-memory      │
              │  key: reverse_scrobble:{u}:{p}    │
              │  TTL: 1h                          │
              └──────────────┬───────────────────┘
                    cache miss│
                             ▼
              ┌──────────────────────────────────┐
              │      fetch_recent_tracks (B1)     │
              │  paginated, max 50 pages (E1 fix) │
              │  150ms delay between pages        │
              └──────────────┬───────────────────┘
                             │ seed weights (time-weighted)
                      ┌──────┴──────┐
                      │             │ (parallel via tokio::join!)
              ┌───────▼──────┐ ┌────▼────────────────────────┐
              │ Pipeline A   │ │ Pipeline B                  │
              │similar_artists│ │user top 5 genres            │
              │× seeds       │ │→ tag.getTopArtists × 5      │
              │(SIMILAR_CONC)│ │= ~250 extra candidates      │
              └───────┬──────┘ └────┬────────────────────────┘
                      └──────┬──────┘
                             │ merge + dedup (MBID > lowercase-norm)
                             ▼
              ┌──────────────────────────────────┐
              │    Filter & Score                 │
              │  obscurity_score (absolute ref)  │
              │  conviction (capped 3.0)          │
              │  stickiness (normalized)          │
              │  taste_alignment                  │
              │  cross_validated bonus (+0.5 flat)│
              │  diversity pass (top 3/genre)     │
              └──────────────┬───────────────────┘
                             ▼
              ┌──────────────────────────────────┐
              │        DiscoveryResponse          │
              │  artists + depth_score + metadata │
              └──────────────────────────────────┘
```

**Eng findings + auto-decisions:**

| # | Finding | Severity | Auto-decision | Principle |
|---|---------|----------|--------------|-----------|
| A3 | Tag pipeline explosion clarification | N/A | Clarified: tag pipeline is 5 USER GENRE calls × 50 = 250 candidates max, NOT per-candidate. Eng reviewer misread design. | — |
| H5 | reqwest 0.11 + axum 0.7 = different hyper versions | CRITICAL | FIX: upgrade to `reqwest = "0.12"` in Cargo.toml | P3 |
| E1 | Pagination: 300k scrobbles = 1500 pages × 150ms = 225s timeout | CRITICAL | FIX: hard page cap at 50 pages (10,000 tracks max per request) | P3 |
| S1 | Username injected into Last.fm URLs without validation | HIGH | FIX: validate `^[a-zA-Z0-9_-]{2,15}$`, reject with 400 before any API call | P1 |
| A1 | CORS fix incomplete: dead `frontend_url` binding not removed | HIGH | FIX: delete dead binding when applying B2 fix | P5 |
| H1 | Time-weighted seeds need chrono for date parsing; "now playing" track has no date | HIGH | FIX: add `chrono` to Cargo.toml; handle `date: None` as skip | P1 |
| H2 | Cross-validation name matching: Last.fm inconsistent capitalization | HIGH | FIX: normalize to lowercase-trimmed; use MBID as primary key when available | P5 |
| E3/S1 | `fetch_user_top_artists` URL-encodes username incorrectly | HIGH | FIX: apply `urlencoding::encode` to username in all URL construction | P5 |
| T5 | No AbortSignal timeout on frontend fetch | HIGH | FIX: add `AbortSignal.timeout(90_000)` with error state fallback | P1 |
| A2 | `audit_cache` DashMap unbounded memory growth | HIGH | FIX: cap at 10,000 entries or add TTL-based eviction | P2 |
| E6 | Obscurity score computed against biased pool (all ≤ 25k listeners) | MEDIUM | FIX: use absolute reference floor/ceiling for depth score normalization | P1 |
| E5 | `#[serde(default)]` missing on `SimilarArtists.artist` | LOW | FIX: add `#[serde(default)]` to prevent panic on absent field | P1 |
| A4 | Redis split-brain on free tier | MEDIUM | DEFER: single Render instance eliminates risk; revisit if scaled | P3 |
| H3 | Diversity cap uses `top_tags[0]` (broad catch-all, not specific) | MEDIUM | FIX: use conviction-weighted genre key for diversity, not first tag | P5 |
| H4 | Depth score clustered 60-75 due to filtered pool | MEDIUM | FIX: use absolute reference (log10(25000) as ceiling) | P5 |

**Test plan (no tests currently exist):**

| Test | Type | What it covers |
|------|------|---------------|
| T1 | Unit | score math: composite, stickiness, obscurity_score at zero/edge values |
| T2 | Deserialization | 5 real Last.fm API response fixtures (TrackDate with/without `#text`, `SimilarArtists` with absent field, now-playing track) |
| T3 | Integration | TOCTOU cache: two concurrent requests for cold key spawn only one pipeline |
| T4 | Unit | 429 retry path: mock client returns 429×2 then 200 |
| T5 | E2E | 50-scrobble user: returns empty with `meta.message` not blank response |

Test plan artifact written to: `~/.gstack/projects/abyss-node-obscurity-engine/test-plan-main.md`

**What already exists (Eng):**
- Scoring loop in service.rs (add obscurity_score and cap)
- `audit_cache` DashMap (cap/evict instead of replace)
- Semaphore concurrency model (extend to tag pipeline)
- `urlencoding::encode` crate (already in Cargo.toml)
- `dashmap` crate (already in Cargo.toml, extend for in-flight dedup)

**NOT in scope (Eng):**
- Multi-instance Redis coordination
- Database persistence
- Rate-limiting middleware (could use `governor` crate, deferred)
- Structured logging (tracing crate, deferred)

**Failure modes registry (combined phases):**

| Failure | Probability | Impact | Phase | Mitigation |
|---------|------------|--------|-------|-----------|
| reqwest/hyper type error on upgrade | Medium | Critical | Pre-Phase 1 | Upgrade to 0.12 first |
| Render 30s timeout for heavy users | High | Critical | Phase 1 | Page cap at 50 pages |
| Username injection to Last.fm | Medium | High | Phase 1 | Validate + encode |
| Cold start kills share link | High | High | Phase 1 | Redis cache (already moved up) |
| Cross-validation name mismatch | High | Medium | Phase 5 | MBID + normalize |
| obscurity_score loses discriminating power | Medium | Medium | Phase 2 | Absolute reference |
| IcebergVisual re-renders scatter nodes | High | Medium | Phase 3 | Hash-seeded positions |

**Phase 3.5 (DX Review): SKIPPED** — Obscurity Engine is a consumer music app, not a developer tool. No public API, no SDK, no onboarding docs. DX scope: NO.

**PHASE 3 COMPLETE.** [subagent-only] 4 critical, 6 high, 5 medium. All auto-decided. 0 taste decisions from Eng. Passing to Phase 4 (Final Gate).

---

### Decision Audit Trail (updated)

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|---------------|-----------|-----------|---------|
| 1 | CEO | Cross-validation bonus: 1.5× → flat +0.5 additive (post-filter) | Mechanical | P1+P3 | Multiplicative bonus rewards popular hubs, not niche artists | Keep 1.5× |
| 2 | CEO | Move Redis cache from Phase 4 to Phase 1 | Mechanical | P2 | Cold start kills share loop; cache is existential, not optional | Keep in Phase 4 |
| 3 | CEO | Add low-data warning (active_seeds < 20) | Mechanical | P5 | Simple frontend string, zero API cost, critical for new users | Skip it |
| 4 | CEO | Defer Last.fm API fragility to TODOS.md | Mechanical | P3 | Can't fix the platform risk; document and move on | Block on it |
| 5 | CEO | Share URL + Depth Score priority vs dual-graph | Taste | P5 | CEO and P5 premise both argue social loop > algo completeness | Surfaced at gate |
| 6 | Design | IcebergVisual: render AFTER ArtistList | Mechanical | P5 | 600px before artist names blocks primary content | Keep before |
| 7 | Design | Period change: keep stale + pulsing refresh indicator | Mechanical | P1+P5 | Full wipe makes period switching feel like crashing the app | Full wipe |
| 8 | Design | Add error state to page.tsx | Mechanical | P1 | Blank screen on API failure is indistinguishable from loading | Skip |
| 9 | Design | cross_validated: bool added to Artist interface | Mechanical | P5 | Field must exist before badge can be built | Skip |
| 10 | Design | Genre Fit: third row TASTE_MATCH: X% above CTA | Mechanical | P5 | Existing grid-cols-2 breaks with third metric | Leave unspecified |
| 11 | Design | Share URL: URL params > localStorage | Mechanical | P5 | Explicit priority prevents silent state conflict | localStorage wins |
| 12 | Design | IcebergVisual X position: hash-seeded from artist name | Mechanical | P5 | Math.random() re-scrambles on every re-render | Keep random |
| 13 | Design | Hero slot for rank #1 (full-width card) | Taste | P1 | Strong discovery moment; taste call on grid uniformity | Surfaced at gate |
| 14 | Design | IcebergVisual: always-on vs collapsible toggle | Taste | P5 | 600px mandatory scroll; taste call | Surfaced at gate |
| 15 | Eng | reqwest upgrade to 0.12 | Mechanical | P3 | reqwest 0.11 + axum 0.7 = different hyper versions | Stay on 0.11 |
| 16 | Eng | Page cap at 50 pages (10,000 tracks) | Mechanical | P3 | 300k scrobble user = 225s timeout on Render free tier | No cap |
| 17 | Eng | Username validation ^[a-zA-Z0-9_-]{2,15}$ + 400 | Mechanical | P1 | Query string injection via crafted username to Last.fm API | Skip validation |
| 18 | Eng | Apply urlencoding::encode to username in all URLs | Mechanical | P5 | Current fetch_user_top_artists has raw username in URL | Leave as-is |
| 19 | Eng | AbortSignal.timeout(90_000) on frontend fetch | Mechanical | P1 | No timeout = spinner forever on dead backend | Skip |
| 20 | Eng | add chrono; handle now-playing track (date: None) | Mechanical | P1 | Time-weighted seeds fail without date parsing | Skip chrono |
| 21 | Eng | Cross-validation: MBID primary key + lowercase normalize | Mechanical | P5 | Last.fm returns inconsistent capitalization across endpoints | Naive string match |
| 22 | Eng | DashMap cap at 10k entries | Mechanical | P2 | Unbounded growth → OOM on free tier over 24h | Leave unbounded |
| 23 | Eng | Diversity cap: use conviction-weighted genre key | Mechanical | P5 | top_tags[0] is broad catch-all, not specific genre | Keep top_tags[0] |
| 24 | Eng | Depth score: absolute reference ceiling/floor | Mechanical | P5 | Filtered pool makes all scores cluster 60-75 | Leave relative |

---

### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|---------------|-----------|-----------|---------|
| 1 | CEO | Cross-validation bonus: 1.5× → flat +0.5 additive (post-filter) | Mechanical | P1+P3 | Multiplicative bonus rewards popular hubs, not niche artists | Keep 1.5× |
| 2 | CEO | Move Redis cache from Phase 4 to Phase 1 | Mechanical | P2 | Cold start kills share loop; cache is existential, not optional | Keep in Phase 4 |
| 3 | CEO | Add low-data warning (active_seeds < 20) | Mechanical | P5 | Simple frontend string, zero API cost, critical for new users | Skip it |
| 4 | CEO | Defer Last.fm API fragility to TODOS.md | Mechanical | P3 | Can't fix the platform risk; document and move on | Block on it |
| 5 | CEO | Share URL + Depth Score priority vs dual-graph | Taste | P5 | CEO and P5 premise both argue social loop > algo completeness | Surfaced at gate |
