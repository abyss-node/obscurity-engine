# TODOS

Deferred work with context. Format: what / why / context / effort (human → CC) / priority.

## From /autoplan review of docs/roadmap-10x-2026-07-02.md (2026-07-02)

- [x] **Bandcamp analysis: candidate source + paid-fan surface** — RESEARCHED
  2026-07-04, see [spike-bandcamp-2026-07-04.md](docs/spike-bandcamp-2026-07-04.md).
  Verdict: candidate source **NO-GO** (every adjacency path — fan
  collections, "fans also bought," Discover tags — requires scraping or
  unauthorized undocumented endpoints, explicitly banned by Bandcamp's AUP;
  official API is seller-account-only); paid-fan link-out **GO** (MusicBrainz
  already has an official Bandcamp artist-URL relationship, no-scraping,
  reuses the existing MB lookup path — ship as a "Support on Bandcamp" link,
  effort S, coverage on our pool unverified — see doc).
- [ ] **Mission-arithmetic section** — write the fan-delivery equation
  (MAU × discoveries/user × concentration per artist) with real numbers once
  the analytics baseline (E1) produces actual MAU; decide what the listener
  app can honestly claim toward the mission. Effort S → S. P2. Depends on: E1.
- [ ] **Competitive one-pager** — Obscurify/stats.fm/Receiptify (taste-toy),
  Spotify for Artists/ChartMetric/Soundcharts (artist analytics),
  ListenBrainz (open infra): who does what, why they won't do obscurity-first,
  what the durable edge is (candidate: attributed obscure-adoption data +
  artist community). Effort S → S. P2.
- [ ] **Unify MAX_LISTENER_CEILING constants** — defined twice
  (backend/src/pipeline/scoring.rs:29, track_scoring.rs:24); single config
  const so "obscurity" has one definition. Also drop vestigial
  `recommended_by`/`conviction_score` fields (models.rs:77-79, never
  populated). Effort S → S. P3.
- [ ] **E4: Artist self-submission v0** *(user decision 2026-07-02: DEFERRED)*
  — form + review queue + candidate-pool injection; the only candidate-source
  fix requiring no CEGE and no scraping; seeds the two-sided marketplace.
  Revisit alongside Phase 4 or if the E3 alternate-source spikes disappoint.
  Effort M → S. P2.
- [ ] **E5: Friend-compare on the share page** *(user decision 2026-07-02:
  DEFERRED)* — compare-with-friend on /u/ or /r/ pages; the proven growth
  mechanic in this category (Obscurify, Receiptify). Revisit when retention
  is measurable post-Phase-2. Effort S/M → S. P2.
