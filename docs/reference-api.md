# HTTP API reference

The backend is a stateless Axum (Rust) service. It exposes four GET endpoints.
No authentication; CORS is locked to the configured `FRONTEND_URL` (any
localhost in dev). Base URL in production:
`https://obscurity-backend-production.up.railway.app`.

## `GET /`

Health check. Returns `200` with the body `ObscurityEngine Backend Alive!`.

## `GET /api/discovery`

The main artist-discovery endpoint.

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | Last.fm username. Validated: 2–15 chars, `[A-Za-z0-9_-]` only. |
| `period` | string | yes | One of `blend`, `7day`, `1month`, `3month`, `6month`, `12month`, `overall`. (`blend` = the UI's "MIX".) |
| `api_key` | string | no | A user-supplied Last.fm API key. When present, the server uses it instead of its own key **and skips the cache** (the result is computed fresh and not stored). |

### Response `200` — `DiscoveryResponse`

```jsonc
{
  "artists": [
    {
      "name": "Putridity",
      "conviction_score": 100,        // conviction × 100
      "stickiness_score": 0.42,       // monthly ÷ total listeners
      "composite_score": 42.0,        // conviction_score × stickiness × genre uplift
      "total_listeners": 24415,
      "top_tags": ["brutal death metal", "death metal", "slam"],
      "source_seeds": [               // which seeds pointed here (sorted by strength)
        { "name": "Devourment", "percentile": 3.0 }
      ],
      "cross_validated": true,        // the DUAL signal (gold ✦)
      "taste_alignment": 0.87,        // 0–1 genre overlap with your profile
      "user_playcount": 0,            // your lifetime plays of this artist
      "reengagement": false,          // true = lightly-played, resurfaced
      "velocity": null,
      "spotify_url": null,            // present only if resolved (needs Spotify creds)
      "bandcamp_url": null,           // present only if resolved server-side
      "this_is_url": null             // Spotify "This Is {artist}" playlist, if any
    }
    // … up to 25 artists, composite-sorted
  ],
  "top_genres": [ { "name": "brutal death metal", "weight": 1.0 } ],
  "deepest_date": null,
  "active_seed_count": 100,
  "depth_score": 49.8,                // the obscurity index, 0–100, over the top 10
  "message": null                     // a [WARN]-style note when results are sparse / history thin
}
```

Notes:
- `artists` is capped at 25 (`MAX_RECOMMENDATIONS`) and sorted by `composite_score`.
  The frontend shows the top 10 by default and reveals the rest on "view more".
- `spotify_url` / `bandcamp_url` / `this_is_url` are omitted (not `null`) when
  unresolved. The frontend always renders Last.fm + Spotify-search + Bandcamp-search
  links and uses these exact URLs only when present.
- `message` is set when the user's history is thin (`active_seed_count < 20`) or
  results are sparse, so the UI can show an explanatory banner instead of a blank page.

### Other responses

| Status | When | Body |
|---|---|---|
| `200` (empty `artists`, with `message`) | user exists but has no listening history for the period | `DiscoveryResponse` with `artists: []` |
| `400` | username fails validation | `{ "error": "Invalid username…", "code": 400 }` |
| `500` | transient Last.fm failure (rate-limit / 5xx / network) after retries | `{ "error": "…rate limit…", "code": 500 }` |

The frontend distinguishes these: a 500 with a rate-limit signature shows
"Last.fm is rate-limiting us, retry"; a fetch that never connects shows
"couldn't reach the service" (and auto-retries once).

## `GET /api/discovery/tracks`

Same query parameters as `/api/discovery`. Returns a `TrackDiscoveryResponse`
(obscure *tracks* rather than artists). Functional but gated behind a
"Coming soon" overlay in the current UI.

## `GET /api/spotify/track`

Optional preview endpoint. Returns a Spotify track match (id, 30s preview URL,
open-in-Spotify URL) for `?artist=&track=`. **Returns `404` when Spotify
credentials are not configured** — which is the case in production today, so a
404 here is the normal "Spotify not set up" signal, not a bug.

## `POST /api/keys`

Opt-in: contribute a Last.fm API key to the server's rotation pool to speed up
discovery for everyone. POST (not GET) so the key never lands in a URL or log.

Request body: `{ "api_key": "<32-char key>" }`. The key is format-checked
(16–64 alphanumeric) and validated against Last.fm with a cheap real call
before being accepted.

| Response | When |
|---|---|
| `200 { "ok": true, "pool_size": N }` | added; pool now has N keys |
| `200 { "ok": true, "duplicate": true, "pool_size": N }` | already in the pool |
| `400 { "ok": false, "error": "invalid key format" }` | bad shape |
| `400 { "ok": false, "error": "key failed Last.fm validation" }` | key doesn't work |

### How the key pool works

The backend holds a pool of Last.fm keys. Owner keys come from a
comma-separated `LASTFM_API_KEYS` env var (falling back to the single
`LASTFM_API_KEY`); user-contributed keys are added at runtime via this endpoint.
`get_with_retry` round-robins across the pool per attempt and benches any key
that returns Error 29 (rate limit) for ~20s. Since Last.fm rate-limits per key,
N keys ≈ N× the aggregate limit — faster cold computes and fewer failures.
User contributions are opt-in and disclosed in the UI.

**Persistence:** set `KEY_STORE_PATH` to a file on a persistent disk (a Railway
Volume) and user-contributed keys are written there and reloaded on boot, so the
opt-in pool survives redeploys. Unset → the pool is in-memory (contributions
reset on restart). Owner keys (`LASTFM_API_KEYS`) come from env each boot and are
not written to the store.

## Caching

- **Server result cache:** in-memory `RwLock<HashMap>`, **1-hour TTL**, keyed by
  `username:period`. Only non-empty results are cached. A custom `api_key`
  bypasses it entirely.
- **Per-artist audit cache:** `artist.getinfo` responses are cached **24h**
  (capped at 10,000 entries) so repeated computes are cheap.
- **Client cache:** the frontend also caches results in `localStorage` for 15
  minutes; the "↺ refresh" control bypasses it.

## Rate limiting & retries

Every Last.fm call goes through `get_with_retry`: up to 4 attempts with
exponential backoff (1s → 2s → 4s) plus jitter. It retries on 5xx, network
errors, and Last.fm's HTTP-200 transient error bodies (Error 29 rate-limit, 8,
11, 16). It fails fast on 4xx and permanent error codes. The pipeline bursts
(no concurrency cap on the fan-out) because it must finish within the request
budget; the jittered backoff spreads retries when a burst trips the limit.

## Related

- [explanation-how-it-works.md](explanation-how-it-works.md) — what produces this response
- [explanation-scoring.md](explanation-scoring.md) — what each score field means
- [howto-deploy.md](howto-deploy.md) — env vars (`LASTFM_API_KEY`, `FRONTEND_URL`, Spotify)
