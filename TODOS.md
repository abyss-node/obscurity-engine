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
- [x] **Competitive one-pager** — DONE 2026-07-03, see
  [competitive-landscape-2026-07.md](docs/competitive-landscape-2026-07.md).
  Original scope: Obscurify/stats.fm/Receiptify (taste-toy),
  Spotify for Artists/ChartMetric/Soundcharts (artist analytics),
  ListenBrainz (open infra): who does what, why they won't do obscurity-first,
  what the durable edge is (candidate: attributed obscure-adoption data +
  artist community). Effort S → S. P2.
- [ ] **Unify MAX_LISTENER_CEILING constants** — MOSTLY DONE 2026-07-03
  (single const at pipeline/mod.rs:44, both scorers import it;
  `recommended_by` dropped). Remaining sliver: vestigial `conviction_score`
  (models.rs:49/147, hardcoded 0 at models.rs:225). Effort S → S. P3.
- [ ] **E4: Artist self-submission v0** *(user decision 2026-07-02: DEFERRED)*
  — form + review queue + candidate-pool injection; the only candidate-source
  fix requiring no CEGE and no scraping; seeds the two-sided marketplace.
  Revisit alongside Phase 4 or if the E3 alternate-source spikes disappoint.
  Effort M → S. P2.
- [x] **E5: Friend-compare on the share page** — SHIPPED 2026-07-04
  (50a35b5): visitor on /r/[id] enters their username, discovery runs with
  the share's period/appetite, renders taste-match % (weighted-Jaccard +
  overlap boost), you'd-both-discover chips, lower-median depth verdict,
  run-your-full-scan CTA. Un-deferred after the Spotify-quota spike demoted
  F5 — share pages are the ungated growth channel.
