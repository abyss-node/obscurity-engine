# Overnight build plan — 2026-07-02

Development task list derived from [roadmap.md](roadmap.md). Scope: every roadmap
item that is actually buildable by code tonight. Items closed by eval, blocked on
user credentials/dashboard actions, or deferred until CEGE are listed at the
bottom with the reason — they are explicitly **not** to be attempted.

## Ground rules for all tasks

- Repo: `C:\Users\Arnuv'\obscurity-engine` (git, branch `main`, clean).
- Backend: Rust (axum-style, `backend/`, `cargo build`/`cargo test`).
  Frontend: Next.js + TypeScript + Tailwind (`frontend/`, `npm run build`).
  Eval harness: Python (`eval/`) — do not touch scoring logic; all scoring
  experiments are closed (see roadmap).
- Commit locally with clear messages. **Do NOT push to origin** — Vercel
  auto-deploys frontend on push; the user reviews in the morning and pushes.
- **No AI attribution anywhere** — no co-author trailers, no "generated with"
  lines in commits, code comments, or docs. Commits are the user's.
- Every task ends with its listed proof — a test or observable behavior that
  demonstrates it works, not just "it compiles".
- Preserve existing behavior when new env vars are absent: the app must run
  identically to today with no new configuration (graceful fallback everywhere).

---

## T1 — Persistent share links (roadmap: "Vercel KV share-link persistence")

**Goal:** shareable result URLs that survive — a friend opening the link sees
the sender's actual results without recomputing, from any browser/session.

**Design:**
1. Storage adapter in `frontend/src/lib/shareStore.ts`:
   - Primary: Upstash-Redis-compatible REST KV, configured via
     `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel Marketplace convention).
   - Fallback when env vars absent: module-level in-memory Map (works in
     `next dev` / single-instance; documented as ephemeral).
   - API: `putShare(payload): Promise<id>`, `getShare(id): Promise<payload|null>`.
   - TTL 30 days; id = 10-char URL-safe random (crypto-based, not Math.random
     in edge-incompatible ways); payload size cap ~100KB with clear rejection.
2. Next.js route handlers: `POST /api/share` (create), `GET /api/share/[id]`
   (fetch). Validate payload shape (username, period, mode, appetite,
   recommendations array, computedAt) — reject anything else.
3. Share page: `/r/[id]` route that fetches the stored payload and renders the
   existing results view (reuse `ArtistList`/`DiscoveryMatrix`/`ShareCard`
   components read-only, with a "get your own" CTA). 404-style friendly state
   for missing/expired ids.
4. Wire the existing share actions (WhatsApp share, copy-link) to call
   `POST /api/share` and use the `/r/[id]` URL when the call succeeds; keep
   today's behavior as fallback when it fails.

**Proof it works:**
- Unit tests (vitest, see T4): adapter roundtrip on in-memory fallback; TTL
  expiry honored; oversized payload rejected; malformed payload rejected by the
  route validator; unknown id → null.
- Route tests: POST→GET roundtrip returns identical payload; GET unknown id → 404.
- E2E smoke: with `next dev` running, create a share via the UI flow (or curl
  POST with a captured real payload), then fetch `/r/[id]` with **no
  localStorage/cookies** (fresh context) and assert the artist names render in
  the HTML.
- `npm run build` passes; no new env vars required for existing flows.

## T2 — Redis-backed backend result cache (roadmap: "Redis cache … multi-instance scaling")

**Goal:** replace the backend's in-memory result cache with a pluggable store so
multiple Railway instances share computed results. In-memory remains the
default; Redis activates only when `REDIS_URL` is set.

**Design:**
1. Locate the current in-memory result cache in `backend/src/` (main.rs or
   pipeline mod). Extract a `CacheStore` abstraction (enum or trait object):
   `get(key) -> Option<CachedResult>`, `put(key, value, ttl)`.
2. `InMemoryStore`: current behavior, unchanged semantics/TTL.
3. `RedisStore`: `redis` crate (tokio async, connection manager), JSON
   serialization of the cached result, TTL via `SET … EX`. On Redis
   connection/serialization error: log a warning and degrade to a miss — never
   fail the request because the cache is down.
4. Selection at startup from `REDIS_URL`; log which store is active.
5. Update `backend/.env.example` and `docs/howto-deploy.md` with `REDIS_URL`.

**Proof it works:**
- `cargo test`: unit tests for `InMemoryStore` (roundtrip, TTL expiry, miss)
  and for `RedisStore` **gated** behind `REDIS_URL` being set in the test env
  (skip cleanly otherwise). If Docker is available locally, spin
  `docker run -d -p 6379:6379 redis:7-alpine` and run the gated tests against
  it, including: roundtrip, TTL, and the degrade-to-miss path (stop the
  container, assert requests still succeed).
- `cargo build --release` passes.
- Behavioral smoke without `REDIS_URL`: start backend, hit the compute endpoint
  twice for the same user/period; assert the second response is served from
  cache (existing cache-hit log line or response-time delta).

## T3 — Design polish pass (roadmap: "Design elements from design-preview.html worth revisiting")

**Goal:** audit `design-preview.html` (and `design-faint-field.html`,
`DESIGN.md`, `design_handoff_results_redesign/`) against the live UI and port
the visual elements that are clearly better — **low-risk only**: typography,
spacing, color tokens, card/surface treatments, micro-interactions. No layout
or information-architecture changes, no component API changes.

**Design:**
1. First produce a short written delta list (design-preview vs current UI) in
   the task branch as `docs/design-delta-2026-07-02.md`: element, current state,
   preview state, port yes/no + why. Port only "yes" items.
2. Apply via Tailwind config tokens / `globals.css` / component classnames.
3. Must not regress: empty/error/loading/onboarding states, discovery appetite
   slider (desktop + mobile), share card PNG export, "view more" → 25, mobile
   responsive layout.

**Proof it works:**
- `npm run build` + typecheck pass.
- Headless-browser QA (gstack `/browse` daemon or Playwright): screenshot
  landing, loading, results, empty, and error states at desktop (1440px) and
  mobile (390px) widths; visually compare against the repo-root baseline
  screenshots (`screenshot_*.png`) and the preview HTML; confirm every listed
  no-regression item renders and the slider still drags on both widths.
- Save the after-screenshots next to the delta doc for morning review.

## T4 — Frontend test harness (enabler for T1/T3; new — the repo has none)

**Goal:** minimal vitest + @testing-library/react setup so frontend logic is
provable now and in future waves.

**Design:**
1. Add `vitest`, `@testing-library/react`, `jsdom` dev-deps; `npm test` script;
   keep config minimal (no snapshot sprawl).
2. Seed tests for existing pure logic: `lib/cache.ts` (roundtrip, TTL expiry,
   quota-full prune path with a mocked localStorage) and `lib/scoring.ts`
   (whatever pure functions it exposes — pin current outputs on 2–3 fixtures).
3. T1's tests live in this harness.

**Proof it works:** `npm test` green locally; tests fail if TTL logic is
deliberately broken (verify once by mutation, then restore).

## T5 — Integration, docs, handoff (final task, after T1–T4 merge)

1. Full builds: `cargo build --release`, `cargo test`, `npm run build`,
   `npm test` — all green on the merged tree.
2. End-to-end smoke on the merged tree: backend + frontend running locally,
   real compute for a known Last.fm user (key already in `backend/.env`),
   then the full share flow (T1) and a cache-hit second run (T2).
3. Docs: update `docs/roadmap.md` (move shipped items to "Recently shipped"),
   `docs/reference-api.md` (share endpoints), `docs/howto-deploy.md`
   (`REDIS_URL`, `KV_REST_API_URL`/`KV_REST_API_TOKEN` setup steps).
4. Write `docs/handoff-2026-07-02.md`: what shipped, what to review, the two
   env-var setups the user must do to activate KV + Redis in prod, and the
   morning checklist (review screenshots → push → set env vars).

---

## Explicitly out of scope tonight (do not attempt)

| Roadmap item | Why not |
|---|---|
| Spotify direct artist links | Code already wired; blocked **only** on user pasting `SPOTIFY_CLIENT_ID`/`SECRET` into Railway. No code change (roadmap). |
| Railway backend auto-deploy | Railway dashboard action, not code. |
| Tracks discovery mode + track-pipeline tuning | Deferred until CEGE (decided 2026-06-21) — same data ceiling as artist engine. |
| "True 1000 fans" threshold model | A/B'd **NO** (2026-06-18, reconfirmed at n=348). Revisit only with CEGE data. |
| Any scoring lever (two-hop, match-weight, velocity, temporal, adaptive, genre-ceiling) | All closed by the n=348 high-power re-validation. Reach is data-capped; CEGE is the unlock. |
| CEGE integration | Separate project (`project_cege`); not an overnight item. |
| LASTFM_API_KEYS owner keys, Railway Volume for KEY_STORE_PATH | User actions (pending list). |
