# Frontend — Next 15 + React 19

You own `frontend/`, except its Dockerfile and `vercel.json`, which are ops'. You
do not edit `backend/`. To learn what an endpoint returns, ask
`backend-consultant` rather than reading Rust — it answers from its own context
window and costs you nothing here. If the contract is wrong or a field is
missing, name what you need and stop. That is a backend session.

## Non-negotiable

**`src/lib/types.ts` is hand-written, not generated.** It mirrors
`backend/src/models.rs` by hand and nothing keeps the two honest. TypeScript will
*not* protect you from a backend change: if a field is renamed server-side,
`types.ts` still declares it, `next build` still passes, and the value is
`undefined` at runtime.

So a type here is a claim about the backend, not a fact. When you rely on a field
that matters, confirm it with `backend-consultant` rather than trusting the
declaration. When the backend adds a field, update `types.ts` in the same change
that consumes it — a mirror that lags is worse than one that is obviously
incomplete.

**Never show an affordance that can silently no-op.** The backend tells you what
it can do: `persistence` on the discovery response, and the capability helpers in
`lib/capability.ts`. A save or dismiss button whose write would be dropped must
not render at all. This is the frontend half of the graceful-degradation
invariant in the root brief.

**Branch on the shape of an error, not on its status alone.** Last.fm serves
application errors under misleading HTTP statuses, and the classification logic
lives in `lib/discoveryError.ts` — use it rather than re-deriving a status check
at the call site. A 404 here does not mean "not found".

**Filters and modes live in the URL.** Period, sort and mode go through
`lib/useUrlModes.ts` so a result is shareable, bookmarkable and survives a
refresh. Do not move that state into a component or a store.

**Invalid periods are a 400, not a fallback.** Since `12d2144` the backend
rejects an unknown `period` rather than silently serving `overall`. Do not add a
client-side coercion that hides it.

## Copy and empty states

- Empty states say what to do next, not "No data". The short-window empty state
  has a real phrase per period in `PERIOD_WINDOWS` — use it.
- The UI label and the wire value are different things. The wire value is
  `blend`; the label is BLEND, and was MIX before 2026-07-09. `PERIOD_LABELS` is
  the single place that mapping lives — never hardcode a label.
- Write user-visible strings whole. Never assemble a sentence by concatenation or
  from fragments spread through conditionals.

## Testing

`vitest` with React Testing Library, 26 colocated `*.test.ts(x)` files beside the
modules they cover.

- `jsdom` is the default environment; a node-only suite opts out per file with a
  `// @vitest-environment node` header.
- Globals are not exposed — import `describe`, `it`, `expect`.
- JSX transform is `automatic` in `vitest.config.ts`; do not import React into
  scope to satisfy a test.

**The canary suite is `lib/`** — scoring, capability, discovery-error
classification, caching, session and share logic. Those encode product rules the
backend cannot enforce for you, and a weakened test there fails silently in a
user's browser rather than loudly in CI.

## TypeScript

React 19 with the automatic JSX runtime — importing React into scope is the
outdated pattern, not the required one.

**`npm run typecheck` is the only type enforcement in this repo.** `next build`
checks nothing: `next.config.js` sets both `typescript.ignoreBuildErrors` and
`eslint.ignoreDuringBuilds`. A green build says the bundle was produced, not
that the code type-checks. Run `typecheck` explicitly, and note it still cannot
catch contract drift — the types it checks are hand-written.

**A page module exports only what Next allows.** `src/app/**/page.tsx` may
export `default`, `metadata`, `revalidate` and the framework's other reserved
names, and nothing else. `page.tsx` used to re-export the domain types and
`PERIOD_LABELS` for backward compatibility; that is a type error which
`ignoreBuildErrors` swallowed for months. Import shared types from
`lib/types.ts` directly — never through a page.

**There is no ESLint config at all.** `next lint` drops into an interactive
setup prompt, which is why CI has no lint step, and it is deprecated in Next 15
in favour of the ESLint CLI. Nothing mechanically refuses a dated construct on
this side; until that changes it falls to review, which is the wrong place for
it.

## Commands

PowerShell-safe.

| Task | Command |
|---|---|
| Dev server | `cd frontend; npm run dev` |
| Tests | `cd frontend; npm run test` |
| Types | `cd frontend; npm run typecheck` |
| Build (type-checks nothing) | `cd frontend; npm run build` |

`NEXT_PUBLIC_BACKEND_URL` defaults to `http://localhost:8080`.

Name which of these you ran and which you only reasoned about.
