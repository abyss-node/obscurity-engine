# Design: artist country from MusicBrainz

Status: APPROVED 2026-10-16, gated on the coverage spike. Display decision:
country · begin year · type ("Sweden · 2014 · band"). Classification: architectural (new
endpoint, new table, new field in the frontend/backend contract).

## Problem

The country column on artist cards, and the "genre · country" line in hero
picks, are mostly blank. The country comes from `countryFromTags`
(`frontend/src/lib/geoTags.ts:149`), which only fires when Last.fm users have
tagged the artist with something geographic ("swedish", "swedish death metal").
Long-tail artists, which is the whole product, rarely carry such tags.

No sibling project has a reusable source. media-year stores no artist country.
album-ratings scrapes country from Metal Archives / Metal Storm (metal only).

## Source: MusicBrainz

`GET /ws/2/artist/{mbid}?fmt=json` returns `country` (ISO 3166-1 alpha-2),
`area.name`, `begin-area.name`, `type` (Person/Group/...), `life-span.begin`.
Free, no key, structured, and it covers small artists far better than tags do.

Rejected:
- **Wikidata:** worse coverage of obscure artists, and SPARQL is slow.
- **Discogs:** needs a token, and country is not a structured artist field.
- **Better tag heuristics:** a tag that nobody added cannot be found by any
  amount of parsing.

## Constraint that shapes everything: 1 request/second

MusicBrainz enforces 1 req/s per IP. The backend already serialises its MB
calls (`mb_sem` + `mb_pacer`, `MB_MIN_INTERVAL` 1050 ms,
`backend/src/listenbrainz.rs:75`) for the ListenBrainz blend arm. Any new MB
traffic must go through that same pacer, or MB will throttle both uses.

So meta lookups must stay off the discovery request's critical path. Inline
lookups for 25 artists would add about 25 s to a cold discovery, which is
already 16-31 s against the frontend's 90 s timeout.

## Design

1. **Lookup, by mbid.**
   - For each displayed artist, get the mbid from Last.fm `artist.getinfo`,
     which the pipeline already calls.
   - Fall back to the existing `mb_search` (score floor 80) when Last.fm has
     no mbid.
   - Then call `GET /ws/2/artist/{mbid}` through the shared pacer.
   - The search path already returns `country` and `area` in its hit, so it
     costs one call, not two.
2. **Permanent store in Postgres, not the cache.**
   - Redis is currently gone and the in-memory cache dies on every redeploy.
     Country of origin does not change, so this is not cache data.
   - New table `artist_meta`:
     - `name_key` (PK), the normalised name, same normaliser as the blend arm
     - `mbid`, `country_iso2`, `area_name`, `begin_year`, `artist_type`
     - `fetched_at`
   - A miss is stored too (null country, `fetched_at`) and retried after
     30 days, so unresolvable artists don't burn MB calls on every discovery.
3. **Separate endpoint, filled in after results render.**
   - `GET /api/artist-meta?name=a&name=b&name=c` (repeated `name=`, max 25) returns what is stored
     immediately, plus `pending: [...]` for names it is still resolving.
   - The frontend calls it once results arrive (top 10 shown, the next 15 on
     "view more"), then re-polls a couple of times while `pending` is
     non-empty.
   - Discovery latency is unchanged.
4. **Display.**
   - Card country = MB `country_iso2` → `Intl.DisplayNames(['en'], {type:'region'})`.
   - Fall back to `area_name` for MB pseudo-codes such as XW or XE, which
     Intl rejects.
   - Fall back again to `countryFromTags`, so nothing that shows today
     disappears.
   - Optional, owner's call: show begin year and type ("Sweden · 2014 ·
     band"), using the same row at no extra cost.
5. **Fail open.**
   - MB down or slow means the field stays on the tag guess.
   - With no `DATABASE_URL`, `artist_meta` falls back to the CacheStore
     (30-day TTL). It is never a hard dependency, per the repo's
     graceful-degradation invariant.
   - `/api/status` gains `musicbrainz: ok|degraded`.

## The seam

The lookup is a plain async function behind the endpoint. If volume ever
justifies it, the same function can run from a background worker that
pre-fills `artist_meta` for every candidate the pipeline scores, without
changing the endpoint or the table.

## What this costs (downsides)

- **Contention with the blend arm.**
  - Meta lookups and blend seed lookups share one 1 req/s budget.
  - A user opening results while another user's cold blend runs will see
    countries arrive slower, and the blend arm may hit its 8 s budget and
    degrade more often.
  - Mitigation: meta requests yield to blend work. They take the semaphore
    only when no blend lookup is waiting.
- **Cold first view.** The first time an artist is shown, its country
  arrives 1-25 s after the card. After that it is instant forever.
- **Contract surface.** One new endpoint, one new migration, a new frontend
  hook, and `reference-api.md` / `reference-schema.md` to update.
- **Wrong matches.** Name-search matches can be wrong for common names. The
  score floor of 80 limits this, and the Last.fm mbid path avoids search
  entirely.

## When we would go the other way

If MB coverage of our actual recommendations turns out low, there is a check
to run first: resolve the last N prod recs and count non-null `country`. If
fewer than about half resolve, this is not worth the plumbing, and better tag
parsing plus a "country unknown" state is the cheaper honest answer.

## Coverage spike result (2026-10-16): gate passed

Sample: 198 real recommended artists, 10 users, from a local backend.
Artifacts are in `tmp/geo-spike/` (gitignored).

| Measure | Coverage |
|---|---|
| MB country | 59% |
| Tags today (`countryFromTags`) | 67% |
| Union of MB and tags | **86%** |
| Begin year | 37% |
| Type | 70% |

- **By genre (union):** metal 66→97%, indie/rock 64→89%, Indian 92→98%.
  Electronic and "other" reach only ~60% even combined.
- **By listener band:** artists under 5K listeners get only 41% MB country,
  because a third of them don't resolve to an MB entry at all.
- **Match quality:** 0 wrong in a 15-artist spot check. 1 clear miss in the
  27 search-path matches.
- **Pseudo-codes:** 0 XW/XE in the sample.
- **Speed:** about 1.33 s of MB time per artist.

Consequences for the build:

- **Precedence.** Use the MB country when present, otherwise the tag guess.
  MB is a fallback that fills gaps, not a replacement for tags.
- **Display.** Render only the parts that exist: "Sweden · 2014 · band",
  "Sweden · band", "Sweden". Begin year will often be absent.

## Acceptance

- Coverage spike first: country fill rate on 100+ real recs, MB vs tags.
- `cargo test` + `npm test` green. Migration runs on boot against a fresh
  database.
- Discovery p50 latency unchanged (measured before and after on 3 users).
- Live: country column populated for the majority of the top 10 on 3 users
  from different genres.
