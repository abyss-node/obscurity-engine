# Spike: Spotify API quota feasibility for F5/F6 (2026-07-03)

**Task:** T-D from [phase0-tasks-2026-07-03.md](phase0-tasks-2026-07-03.md). Research only, no
code. Question: can Obscurity Engine realistically obtain Spotify Web API access at the scale
F5 (Spotify account linking → top artists / recently played driven recs) and F6 (direct
Spotify links / playlist creation) assume?

## 1. Development Mode user cap and the extended-access process

**Current cap (as of this writing, effective March 9 2026 for all Development Mode apps,
including pre-existing ones): 5 authenticated users per Client ID, one Development-Mode
Client ID per developer, and the app owner must hold an active Spotify Premium
subscription** (if it lapses, the app stops working).

- Source: [Update on Developer Access and Platform Security](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)
  (Spotify for Developers blog, 2026-02-06) — "Each Client ID will be limited to up to five
  authorized users," "Development Mode use will require a Spotify Premium account," one
  Development Mode Client ID per developer. New Client IDs created after **Feb 11 2026** must
  comply immediately; **existing** Development Mode integrations had until **March 9 2026** to
  comply.
- Source: [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
  (official docs) — "Up to 5 authenticated Spotify users can use an app that is in development
  mode." Requests from users beyond the allow-listed set return HTTP 403. (This page reflects
  the post-Feb-2026 cap; historically the Development Mode cap was 25 users before this
  change — see the TechCrunch coverage below for the pre-2026 baseline.)
- Corroboration: [Spotify changes developer mode API to require premium accounts, limits test
  users](https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/)
  (TechCrunch, 2026-02-06) confirms the 25→5 user reduction and the Premium requirement, framed
  as an anti-abuse/anti-scraping measure.

**Important nuance for what actually counts against the cap:** the 5-user limit applies to
*authenticated users*, i.e. accounts that complete Spotify's Authorization Code OAuth flow and
grant the app a user-scoped token. Endpoints that only need an app-level **Client Credentials**
token (no specific user logged in — e.g. catalog `search`) are not tied to a "user" and are not
throttled by the 5-user cap, only by the app's general rate limit. Endpoints that require a
user's own data (top artists, recently played, creating a playlist *in that user's account*)
necessarily use a user-scoped token and do count against the cap.
Source: [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
(authorization-flow distinction is Spotify's standard OAuth model, documented alongside the
quota-mode description on this same page).

**Extended access (formerly "Extended Quota Mode," now generally referred to as Standard/
Extended access on the review form) — the process to lift the 5-user cap:**

- As of **May 15 2025**, Spotify **only accepts extended-access applications from legally
  registered organizations, not individuals**, and requires: a legally registered business,
  an active/launched service already operating, **250,000+ monthly active users (MAUs)**,
  presence in key Spotify markets, demonstrated commercial viability, and Developer Terms
  compliance.
  Source: [Updating the Criteria for Web API Extended Access](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access)
  (Spotify for Developers blog, 2025-04-15) — states extended quota is now reserved for
  "established, scalable, and impactful use cases," that over 95% of prior applicants failed
  Spotify's security/privacy/licensing bar, and that fewer than 1% of *existing* extended-access
  developers already in compliance are grandfathered/unaffected.
- Application process: submit via the [extended-access request form](https://docs.google.com/forms/d/1O87xdPP1zWUDyHnduwbEFpcjA57JOaefCgBShKjAqlo)
  linked from the quota-modes doc, using a company email; **review can take up to six weeks.**
  Source: [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

Net: Obscurity Engine — an unincorporated side project with no MAU anywhere near 250,000 — does
not currently meet the eligibility bar to even *apply* for extended access, let alone be
approved. The 250k-MAU / registered-organization requirement, not review turnaround time, is
the binding constraint.

## 2. Nov 2024 endpoint deprecations — do they hit F5/F6's specific endpoints?

On **2024-11-27** Spotify deprecated a named set of endpoints for **new** Web API use cases
(apps registered after that date, or existing Development Mode apps without a pending
extension request at the time):

> Related Artists, Recommendations, Audio Features, Audio Analysis, Get Featured Playlists,
> Get Category's Playlists, 30-second preview URLs (in multi-get track/episode responses), and
> algorithmic/Spotify-owned editorial playlists.

Source: [Introducing some changes to our Web API](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
(Spotify for Developers blog, 2024-11-27); corroborated by
[Spotify cuts developer access to several of its recommendation features](https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features/)
(TechCrunch, 2024-11-27) and [Spotify removes features from Web API citing security
issues](https://musically.com/2024/11/28/spotify-removes-features-from-web-api-citing-security-issues/)
(Music Ally, 2024-11-28).

**None of the four endpoints F5/F6 need are on that list:**

| Endpoint F5/F6 needs | On the Nov-2024 deprecation list? | Status for new apps (this spike) |
|---|---|---|
| User's top artists (`GET /me/top/artists`) | No | Available — confirmed no deprecation banner on the [official reference page](https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks) |
| Recently played (`GET /me/player/recently-played`) | No | Available — explicitly called out as unaffected in the Feb-2026 migration guide (see below) |
| Search (`GET /search`) | No | Available, but parameters are being tightened (see below) |
| Create playlist (`POST /me/playlists`) | No | Available — the Feb-2026 migration guide explicitly notes "Playlist creation endpoints remain functional" |

So the Nov-2024 cut does **not** block F5/F6 by itself. The deprecated set (Related Artists,
Recommendations, audio features/analysis) would have hit a *content-based-recommendation*
feature, not the *account-linking / personal-history* feature F5/F6 is scoped to.

**However, a second, more recent restructuring compounds the picture.** A **February 2026**
Web API change (rolling out alongside the Development Mode cap change above; new Client IDs
from **Feb 11 2026**, existing integrations migrated by **March 9 2026**) additionally:
removes `GET /artists/{id}/top-tracks` (an *artist's* top tracks — distinct from the `/me/top/
artists` endpoint F5/F6 actually needs, which is unaffected), consolidates several library
endpoints, renames playlist-track endpoints to `/items`, removes multi-ID batch-fetch endpoints
(`GET /tracks`, `/albums`, `/artists`, etc. — callers must fetch one ID at a time), removes
`GET /browse/new-releases` and category browsing, removes `GET /users/{id}` for anyone but the
current user, and **reduces the `search` endpoint's `limit` parameter (max 50→10, default
20→5)**.
Source: [February 2026 Web API Dev Mode Changes — Migration Guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
(official docs).
Per the same Feb 2026 announcement, **Spotify has since postponed the endpoint-removal portion
of this change for existing integrations** ("we have decided to postpone endpoint access
changes for existing integrations") — only the Premium requirement, 5-user cap, and
single-Client-ID limit are confirmed to be enforced on the March 9 2026 date; the endpoint
removals' timeline for *existing* apps is unresolved as of this writing. New apps registered
after Feb 11 2026 are subject to the full endpoint restructuring immediately.
Source: [Update on Developer Access and Platform Security](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security).

Net for F5/F6: none of the four needed endpoints are deprecated or removed for new apps under
either the Nov-2024 or Feb-2026 changes. `search` keeps working with a smaller page size, which
is a pagination annoyance, not a blocker (Obscurity Engine's search use is small-scale artist
lookups, not exhaustive catalog crawls).

## 3. 2025-2026 policy trend summary

Three moves in ~15 months, all tightening:

1. **2024-11-27** — deprecate a named batch of endpoints (recommendation/content-analysis
   family) for new apps. Does not hit F5/F6.
2. **2025-04-15 / effective 2025-05-15** — extended-access eligibility narrowed to
   organizations with 250k+ MAU, an active launched service, and a legal business entity.
   Blocks Obscurity Engine from ever exceeding Development Mode limits at its current stage.
3. **2026-02-06 / effective 2026-02-11 (new apps) & 2026-03-09 (existing apps)** — Development
   Mode cap cut from 25 to 5 users, Premium-account requirement for the app owner, one
   Client ID per developer, plus a broader endpoint restructuring (partially postponed for
   existing integrations). Directly caps how many real users can ever link Spotify to
   Obscurity Engine without extended access.

Sources for the trend: all four items above, plus general framing from
[Spotify's API Lock-Down: The End of Open Data for the Music Business?](https://medium.com/@apollinereymond/spotifys-api-lock-down-the-end-of-open-data-for-the-music-business-0a9bf07dba27)
(Medium, industry commentary — used only as corroborating color, not as a primary source for
any figure cited above).

## Verdict: GO-WITH-CAPS

F5/F6's specific endpoints (top artists, recently played, search, playlist create) are not
blocked for new apps by either the Nov-2024 or Feb-2026 endpoint changes. The real constraint
is **access scale**, not endpoint availability: Development Mode now hard-caps Spotify-account
linking at **5 authenticated users per Client ID**, and Obscurity Engine has no realistic path
to Extended/organization-tier access (250k+ MAU, registered business) at its current size.

**Recommended path:**

1. Ship F5 (Spotify account linking for top-artists/recently-played-driven recs) and F6
   (playlist creation, direct Spotify links) as an **opt-in, allow-listed beta feature**,
   capped at the 5 authenticated users Development Mode permits. Manually add beta testers'
   Spotify accounts to the app's allow-list in the Developer Dashboard; ensure the app-owner
   account (whoever registers the Client ID) keeps an active Premium subscription, per the
   March 2026 requirement.
2. For any *search-only* usage (e.g. resolving artist names to Spotify IDs for "open in
   Spotify" deep links) that does not need a specific user's data, use the **Client Credentials
   flow** instead of a user-authorized token — this is app-level auth and is not counted
   against the 5-user cap (only the general per-app rate limit applies), so it can serve
   unlimited visitors even though the account-linking parts of F5/F6 cannot.
3. Do **not** budget Phase-1/2 roadmap time toward applying for Extended access — Obscurity
   Engine does not meet the eligibility bar (no registered business entity, MAU orders of
   magnitude below 250,000). Revisit only if/when the product has both (a) a legally
   registered business entity behind it and (b) is approaching real-world MAU in the tens of
   thousands, as a leading indicator that 250k is reachable — call that **threshold X**. Until
   then, treat F5/F6's account-linking surface as a small, manually-curated beta feature, not a
   scaled product feature.
4. Track Spotify's developer blog for the still-pending resolution of the postponed
   endpoint-removal timeline for existing integrations (per the Feb 2026 post) before
   committing further engineering time to endpoints outside the four F5/F6 needs (e.g. do not
   build on `/artists/{id}/top-tracks`, multi-ID batch fetches, or `/browse/*`, all of which are
   already gone for new apps and only temporarily preserved for existing ones).
