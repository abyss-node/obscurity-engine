# Spike: Bandcamp as candidate source + paid-fan surface (2026-07-04)

**Task:** TODOS.md item "Bandcamp analysis: candidate source + paid-fan surface"
(queued by the `/autoplan` review of `docs/roadmap-10x-2026-07-02.md`, E10,
2026-07-02: *"'1000 true fans' is about fans who pay; Bandcamp is where
obscure-artist fans pay, and its Discover/fan-collections graph is an
unanalyzed candidate source. Research first (API/ToS, adjacency quality),
then A/B in the eval harness like E3's alternates."*). **Research only — no
code changes, eval/** untouched.**

## Context

The 10x roadmap's data-ceiling finding (`docs/roadmap-10x-2026-07-02.md`,
"three ceilings") is that candidates come exclusively from Last.fm
`artist.getsimilar` — popularity-biased, genre-clustering — and every
scoring-lever A/B at n=348 confirmed reach is flat regardless of ranking;
only a richer candidate graph moves it. The Last.fm+ListenBrainz blend
(`docs/blend-n348-2026-07-03.md`) is the first candidate source to actually
move reach (+9.5% relative, significant). CEGE is the long-run bet. Bandcamp
was flagged as a third possible candidate source because its catalog skews
independent/DIY — plausibly denser in exactly the long-tail obscure segment
the mission cares about — and separately because "1000 true fans" is
explicitly about *paying* fans, and Bandcamp is the place obscure-artist fans
pay. This spike answers both questions before any harness work is scoped.

The repo's standing architecture rule (confirmed via `candidates.rs` /
`eval/pipeline.py`'s `CandidateSource` seam and every closed roadmap item):
**no scraping-dependent candidate source.** A source that only works via
scraping is a NO-GO regardless of technical feasibility or adjacency quality
— stated up front because it turns out to be the load-bearing constraint
below.

## Method

WebSearch + WebFetch against: Bandcamp's own developer/ToS/policy pages,
Bandcamp Updates blog, MusicBrainz relationship docs and public web service,
MetaBrainz/ListenBrainz docs and community discourse, third-party
scraper-API marketplaces (Apify, ScrapingBee, Musicfetch, Stevesie) as
evidence of what only-via-scraping actually exposes, and one industry
analysis (Chartlex, 2026) on Bandcamp's discovery mechanics. No Bandcamp
account was created and no scraping or reverse-engineered endpoint was
called — consistent with the no-scraping rule applying to this research
itself, not just to shipped code. One MusicBrainz public web-service query
was attempted (`GET /ws/2/url?query=...bandcamp.com...`, the official free
API, not Bandcamp's) to get a coverage count; the fetch tool's returned
"count: 0" is almost certainly a tool/query-encoding artifact (MusicBrainz
plainly has non-zero Bandcamp URLs on file — see Q4) and is **not** treated
as a real finding below; flagged as unresolved.

## Findings

### Q1 — Does Bandcamp offer an official public API today (2026)?

Yes, but it is narrow and non-public. **`bandcamp.com/developer`** documents
exactly three APIs, all OAuth 2.0, all requiring Bandcamp to manually
provision a client ID/secret after you email them a description of your
intended use — there is no self-service signup:

- **Account API** — list of bands a user manages + basic account metadata.
- **Sales Report API** — sales line items (digital/physical/merch/subscription)
  over a date range.
- **Merch Orders API** — query/fulfill physical merch orders (for labels and
  their fulfillment partners specifically).

Access is explicitly scoped to **"labels and merchandise fulfillment
partners"** managing accounts that already sell on the platform — i.e.
sellers administering their own sales/inventory data, not third parties
building discovery or recommendation products. [bandcamp.com/developer]
None of the three APIs expose search, Discover feeds, fan collections,
"fans also bought," or any recommendation-relevant data.

**History:** there was an older, more general Bandcamp API documented publicly
until roughly 2016 (an Internet Archive snapshot of "the legacy Bandcamp API"
is the primary trace of it), which Bandcamp subsequently pulled from public
docs. Since then, community projects (`michaelherger/Bandcamp-API`,
`har-nick/bandcamp-api-docs`) have reverse-engineered and documented the
undocumented web endpoints the Bandcamp site itself calls (band info,
following, collections, wishlist) purely from observed network traffic,
explicitly because Bandcamp does not document them. [github.com/michaelherger/Bandcamp-API]
A separate 2024 write-up reverse-engineers Bandcamp's *auth* protocol for the
same reason. [mijailovic.net/2024/04/04/bandcamp-auth]

**Epic Games / Songtradr:** Epic Games bought Bandcamp in March 2022 and sold
it to Songtradr in October/November 2023 (roughly 18 months later), alongside
Epic layoffs; about half of Bandcamp's staff were not retained by Songtradr.
[musicbusinessworldwide.com/5-observations-on-epic-games-sale-of-bandcamp-to-songtradr,
blog.bandcamp.com/2023/11/22/songtradr-acquires-bandcamp] No search result —
official blog, developer docs, or press — surfaced any new public API,
partner program, or data-access announcement tied to either the Epic
acquisition or the Songtradr sale, through either company's public
communications as of this research date (2026-07-04). The developer page's
scope (label/merch-partner only) reads as unchanged from its pre-acquisition
shape.

**Verdict for Q1:** the only sanctioned API surface is a private,
manually-approved, seller-account-management API. There is no official
public API for search, discovery, or fan-graph data, and no evidence either
ownership change introduced one.

### Q2 — Can artist-adjacency be derived legitimately?

No. Every adjacency signal a candidate source would need —
"fans also bought" / "supported by" panels, fan collections (who-owns-what),
Discover category/tag membership, artist-to-artist recommendations — is
rendered only on Bandcamp's public web pages and the app's internal
(undocumented) endpoints. None of it is in the official Account / Sales
Report / Merch Orders APIs above. The only ways to obtain it today are (a)
HTML scraping of pages, or (b) calling the reverse-engineered internal
endpoints the community has documented (which is functionally the same
access pattern as scraping — unauthenticated, unsupported, ToS-violating
calls to endpoints Bandcamp built for its own front end, not for third
parties).

Bandcamp's Acceptable Use and Moderation Policy — incorporated by reference
into the Terms of Use (the ToU's Rules and Conduct section requires
compliance with it; the ToU itself has no separate scraping clause) —
states directly, in the policy's own wording:

> "Not to scrape any text, media, or other data or content from the site,
> including through the use of scripts, robots, bots, spiders, scrapers,
> crawlers, or other automated means"
>
> "Not to undertake any form of text and/or data mining of content,
> including where collected through the use of robots or other automated
> data gathering and/or extraction tools"
>
> "Not to train any machine learning or AI model using content on our site
> or otherwise ingest any data or content from Bandcamp's platform into a
> machine learning or AI model"

[get.bandcamp.help/hc/en-us/articles/23005947027991, incorporated per
bandcamp.com/terms_of_use "Rules and Conduct"]

This directly and explicitly prohibits every viable acquisition path for
Bandcamp adjacency data. There is no gray area to litigate here — the ToS
language is unambiguous and covers scraping, automated data mining, *and*
ML/AI ingestion of the resulting data, which is exactly what a candidate
source would do with it.

**Note for context, not as a mitigating factor:** a visible commercial
ecosystem of Bandcamp scraper APIs currently operates in the open (Apify,
ScrapingBee, Musicfetch, Stevesie, and others, found via plain web search)
— i.e. Bandcamp is not aggressively enforcing against every scraper today.
No cease-and-desist precedent against a specific app was found in this
research. That tells us enforcement risk may be low in practice, but it does
not change the verdict: the project's rule is architectural ("no
scraping-dependent architecture"), not a risk-tolerance calculation, and the
ToS prohibition is explicit regardless of enforcement patterns.

**Verdict for Q2: NO-GO, unconditionally.** Every path to Bandcamp
artist-adjacency data is scraping-dependent (either literal HTML scraping or
calling undocumented endpoints without authorization) and explicitly
forbidden by Bandcamp's own policy. This is exactly the case the project's
standing rule anticipated — say so plainly: **candidate-sourcing from
Bandcamp is a NO-GO regardless of adjacency quality**, so Q3 below is
answered for completeness/future-reference only, not because it could change
the verdict.

### Q3 — Adjacency quality (desk assessment, moot given Q2, answered for the record)

Secondary-source evidence suggests Bandcamp's purchase-graph adjacency would
have been genuinely interesting for exactly this product's target segment,
*if* it were legitimately accessible:

- A 2026 industry analysis reports the "fans also bought" collaborative-filter
  panel works well in genres "where fans actively buy multiple artists' work"
  — it names ambient, modular synth, vaporwave, shoegaze, post-rock, jazz,
  and experimental electronic as strong-adjacency genres, and poorly in
  single-purchase genres like mainstream pop/rap — and cites "18 to 24
  percent of new customers on a given release" arriving via that panel for
  tracked indie campaigns. [chartlex.com/blog/marketing/bandcamp-discovery-algorithm-fan-finding-2026]
  The genre profile named overlaps substantially with what an "obscure
  artist" candidate pool on this product already looks like.
- The same source frames Bandcamp's overall discovery infrastructure as
  "fundamentally sparse compared to streaming platforms" — no personalized
  homepage feed, no "for you" tab — with Discover surfacing driven primarily
  by tag accuracy/completeness and editorial curation rather than deep
  behavioral modeling.
- Bandcamp's own blog states community features (Discover, artist recs, fan
  collections, feed) drive roughly 30% of monthly sales, and frames a fan's
  collection as "the holy grail of support" — evidence the graph is used and
  valued internally, but not a public density/coverage statistic broken out
  by obscure vs. popular artists.

No public writeup, data blog post, or third-party analysis was found that
directly measures fan-collection graph *density in the long tail specifically*
(e.g. average co-purchase edges per artist below some listener threshold).
This is a genuine evidence gap — the assessment above is a reasonable desk
read, not a verified quantitative comparison to Last.fm `getsimilar` or
ListenBrainz session-based similarity density.

### Q4 — Paid-fan link-out surface (separate from candidate sourcing)

This is a different and much cleaner question: not "read Bandcamp data to
build recommendations" but "link out to an artist's own Bandcamp page,"
which requires no scraping at all if a resolvable artist → Bandcamp-URL
mapping exists somewhere the app can already query legitimately.

MusicBrainz has exactly this: an official, first-class **Bandcamp artist-URL
relationship type** (id 718, UUID `c550166e-0548-4a18-b1d4-e2ae423a3e88`,
link phrase "Bandcamp" / "Bandcamp page for"), documented in the
[Artist-URL relationship types](https://musicbrainz.org/relationships/artist-url)
style guide and demonstrated live on artist pages (e.g. David Rovics →
`davidrovics.bandcamp.com`). [musicbrainz.org/relationship/c550166e-0548-4a18-b1d4-e2ae423a3e88]
Any MB editor (label, artist, or fan) can add it, and it is queryable via
MusicBrainz's free, public, no-scraping web service —
`GET /ws/2/artist/{mbid}?inc=url-rels` — the same official API surface this
codebase already depends on elsewhere. This is precisely the "clean URL
scheme resolvable from artist name/MBID" the research question asked about,
and it fits the existing architecture with zero new ToS exposure.

**What I could not establish:** actual coverage — what fraction of artists
in this product's typical recommendation pool (obscure/independent, exactly
Bandcamp's core demographic) have this relationship populated. I attempted a
live count via the public MB web service
(`GET /ws/2/url?query=bandcamp.com`), but the returned "count: 0" is not
credible (MusicBrainz obviously stores far more than zero Bandcamp URLs
system-wide — e.g. the worked example above) and is most likely an artifact
of this research pass's query encoding or the fetch tool's handling of the
raw JSON response rather than a real MusicBrainz answer. I am **not**
reporting a coverage number and flagging this explicitly as unresolved
rather than guessing. Directionally, coverage should skew *favorably* for
this product's use case (independent-leaning artists are more likely to have
active MB editors who bother adding a Bandcamp link than mainstream artists
who route everyone to Spotify), but that is a prior, not a measurement.

**Verdict for Q4: GO**, sized to a graceful-degradation link ("Support on
Bandcamp" button rendered only when the MBID→Bandcamp relationship exists;
otherwise hidden — same pattern the codebase already uses for other
optional listen-links) — no new legal exposure, no new infrastructure
dependency, reuses an API surface already in the stack.

### Q5 — Precedents

- **ListenBrainz/MetaBrainz:** the only Bandcamp mention found in
  ListenBrainz's own docs is that ListenBrainz *accepts* listens submitted
  from Bandcamp via the third-party WebScrobbler browser extension — i.e.
  Bandcamp is a scrobble *source*, tagged `music_service: "bandcamp.com"` in
  submitted listen payloads, the same way Last.fm accepts scrobbles from any
  client. [listenbrainz.readthedocs.io/en/latest/users/json.html] This is
  not a partnership, data-sharing agreement, or candidate-source
  integration — it is a passive artifact of users' own scrobbling client
  choice. No MetaBrainz blog post, GSoC project, or community-discourse
  thread describing a deliberate Bandcamp data partnership or adjacency
  integration was found.
- **Other apps:** the visible ecosystem of Bandcamp integrations is entirely
  the scraper-API vendors noted in Q2 (Apify, ScrapingBee, Musicfetch,
  Stevesie) — commercial scraping-as-a-service products, not sanctioned
  partnerships. No case of an app being issued a cease-and-desist or losing
  access specifically for this was found in this research pass (absence of
  evidence, not evidence of a green light — this project should not read it
  as a signal either way, per the no-scraping architecture rule).
- No evidence of any other consumer discovery app (Obscurify, stats.fm,
  Receiptify — the same set surveyed in `docs/competitive-landscape-2026-07.md`)
  sourcing candidates from or partnering with Bandcamp.

## Verdicts

**(a) Candidate source: NO-GO — unconditional.**
Reasoning: every path to Bandcamp adjacency data (fan collections, "fans
also bought," Discover categories, artist recommendations) is either raw
HTML scraping or calling undocumented internal endpoints without
authorization — both explicitly prohibited by Bandcamp's Acceptable Use
Policy ("not to scrape... through scripts, robots, bots, spiders, scrapers,
crawlers, or other automated means," "not to undertake any form of text
and/or data mining," "not to... ingest any data or content from Bandcamp's
platform into a machine learning or AI model"). The official developer API
(`bandcamp.com/developer`) covers only seller account/sales/merch data for
approved label and fulfillment partners and exposes none of the graph data a
candidate source needs. This is precisely the scraping-dependent
architecture the project rules out regardless of technical feasibility or
(desk-assessed, genuinely promising per Q3) adjacency quality. Remove this
from the CEGE-alternates list; it should not consume eval-harness time.

**(b) Paid-fan link-out surface: GO.**
Reasoning: MusicBrainz's official Bandcamp artist-URL relationship type is a
legitimate, no-scraping, already-in-stack mechanism (`GET
/ws/2/artist/{mbid}?inc=url-rels`) to resolve an artist's Bandcamp page and
add it as a "support this artist" link alongside the existing Last.fm/Spotify
listen links. Coverage/completeness is unverified (flagged above) but the
mechanism itself carries no legal or architectural risk and directly serves
the "1000 true fans who pay" framing better than any streaming-service link
does, since Bandcamp is where obscure-artist fans actually spend money.

## Recommended next actions (sized)

- **S — Ship the Bandcamp link-out.** Add a `bandcamp_url` field to the
  artist enrichment step, populated via the existing MusicBrainz lookup path
  (if one exists in the pipeline) or a new MBID→url-rels call; render a
  "Support on Bandcamp" link/button on `ArtistCard` only when present, same
  hide-if-absent pattern as other optional links. No eval harness changes
  needed (not a scoring input).
- **S — Verify MB coverage before committing engineering time.** Before
  building the above, run one clean, correctly-encoded call against
  `GET /ws/2/url?query=...` (or better, sample ~50 MBIDs already flowing
  through the pipeline today and check `inc=url-rels` directly) to get a real
  coverage percentage on this product's actual candidate pool, since this
  spike could not establish that number reliably. This closes the one open
  question in Q4 and should take under an hour.
- **Remove Bandcamp from the candidate-source alternates list.** Update any
  planning doc that still lists Bandcamp alongside CEGE/ListenBrainz as an
  under-explored candidate source (this spike is that removal for
  `TODOS.md`); no further harness/A-B work should be scoped against it.
- **No action (L, not recommended):** pursuing Bandcamp's official
  label/merch-partner API for anything candidate-source-shaped is a dead
  end — it doesn't expose the needed data at any tier, so there's no
  "apply and wait" path the way there was for Spotify Extended Access.

## What I could not establish from public sources

- A reliable count of how many artists in MusicBrainz (or in this product's
  actual recommendation pool) have a populated Bandcamp artist-URL
  relationship. My own attempted live query returned a result I do not
  trust (see Q4); this needs a follow-up call made correctly, not more web
  research.
- Any quantitative comparison of Bandcamp fan-collection graph density vs.
  Last.fm `getsimilar` or ListenBrainz session-based similarity specifically
  in the long tail (sub-10K-listener artists). Only qualitative,
  secondary-source commentary was found (Q3).
- Whether Bandcamp has ever formally rejected or revoked API access from a
  discovery/recommendation-shaped applicant (as opposed to a scraper) — no
  such case surfaced in this research pass either way.

## Appendix: coverage probe results (2026-07-04)

Follow-up to the unresolved item above, run via `scripts/mb_bandcamp_coverage.py`
(read-only against the public MusicBrainz web service; no eval/** changes,
no Bandcamp scraping). The script's own live query, made correctly this
time — MB artist search at the same `score >= 80` threshold
`backend/src/listenbrainz.rs::mb_search` uses, then
`GET /ws/2/artist/{mbid}?inc=url-rels` per resolved MBID, paced at 1.1s/call
with a descriptive User-Agent matching the codebase's existing MB politeness
pattern — replaces the spike's non-credible `count:0`.

**Sample:** 40 hand-picked artist names spanning obscure-DIY to
well-known-indie, skewed toward the genres Q3 flagged as Bandcamp-adjacency-strong
(ambient, shoegaze, post-rock, experimental electronic, DIY bedroom pop).
Committed `eval/*.json` artifacts were checked first per the task brief, but
every one (`blend_n348.json` included) stores only aggregated per-user
metrics (hits/reach/precision/etc.) — none retain the actual recommended
artist names (those live only in the gitignored, uncommitted `eval/.cache/`).
So this is a hardcoded proxy sample, not a draw from a committed artifact —
noted here explicitly as the task brief allows.

**Results:**

| Metric | Value |
|---|---|
| N sampled | 40 |
| Resolved to an MBID (score ≥ 80) | 38 / 40 (95.0%) |
| Of resolved, has a Bandcamp artist-URL relationship | 35 / 38 (92.1%) |
| Errors (network/transport) | 0 |

Unresolved (no MB match ≥ score 80): "Parannoul", "For Elissa" — both
genuinely deep-long-tail/DIY names likely thin or absent in MusicBrainz
itself, not a query-encoding artifact (no errors were logged; this run's
`mb_search` call shape is byte-identical to the Rust code's). Of the 38
resolved artists, only "Julie", "TOPS", and "Nostalgist" resolved without a
Bandcamp relationship populated.

**Recommendation:** the MB-precise upgrade is worth building — with one
caveat on the headline number: the sample was deliberately skewed toward
Bandcamp-adjacency-strong genres, so 92% is an optimistic upper bound for
the app's real recommendation mix (a genre-neutral draw from live rec
output would likely land lower; re-measure against actual recommendations
before treating this as a production hit rate). Even discounted, the rate
is far higher than this spike's cautious prior, confirms Q4's directional read (independent-leaning
artists' MB entries are well-maintained here), and the resolution path
(MBID search + `url-rels` lookup) is mechanically identical to the
MusicBrainz calls `backend/src/listenbrainz.rs` already makes for the blend
candidate source — no new infra, same rate-limit budget. Net: swap the
current `bandcamp_url` fallback from "always search-link" to "MB `url-rels`
lookup, fall back to search-link only on miss," gated behind the existing
per-artist MBID resolution the blend path already performs when
`CANDIDATE_SOURCE` includes ListenBrainz/Blend (Last.fm-only mode has no
MBID in hand and would need its own resolve call, same cost as today's
Spotify/`"This Is"` resolution).
