# Obscurity Engine

## What we are building

A Last.fm discovery engine. Given a listening history it surfaces artists the
listener has not found yet, ranked by how *under-reached* they are rather than by
how unknown they are.

The north star is not novelty. **It is helping under-discovered artists reach
their true 1000 fans.** Obscurity here is engagement-relative under-reach —
distance-to-1000 — composed from engagement, genre and country axes. A feature
either serves that loop or earns its place some other way.

## Lanes

Work happens in one lane at a time. Put the hat on before starting.

| Lane | Owns | Brief |
|---|---|---|
| **backend** | `backend/` except its Dockerfile — Axum service, pipeline, scoring, persistence | `/backend`, then `backend/CLAUDE.md` |
| **frontend** | `frontend/` except its Dockerfile and `vercel.json` — Next app, components, copy | `/frontend`, then `frontend/CLAUDE.md` |
| **eval** | `eval/` — the offline Python harness. Ships nothing | `/eval`, then `eval/CLAUDE.md` |
| **ops** | repository root, `.github/`, both Dockerfiles, `docker-compose.yml`, `railway.json`, `render.yaml`, `start.sh`, `frontend/vercel.json` | `/ops` |

**Editing is lane-bound. Reading is not.** To learn something about another lane,
ask `backend-consultant` or `frontend-consultant` rather than reading your way
across the tree. They are read-only by design, so if the answer means another
lane has to change, say so and stop. That is a separate session.

`docs/` belongs to no lane and is edited from any.

## The contract is undefended — this is the most important fact in the repo

`frontend/src/lib/types.ts` is **hand-mirrored** from `backend/src/models.rs`.
There is no OpenAPI spec, no generated client, no codegen step, and no CI job
that compares them. `.github/workflows/` contains one file and it is a keep-warm
ping.

So: rename a field in `models.rs` and **both sides still compile.** The frontend
reads `undefined` at runtime and a screen renders blank. `cargo test` passes,
`next build` passes, nothing goes red.

Two consequences, and they bind every lane:

- Before renaming or removing any field that crosses the wire, ask the consultant
  on the other side. "Does anything consume this?" is the only defence that
  exists here.
- `docs/reference-api.md` is **not authoritative.** It was last updated
  2026-07-03 and is already wrong: it omits the `ytd` period entirely and still
  calls BLEND "MIX", both of which changed on 2026-07-09 in `12d2144`. Read the
  Rust for the contract; treat that document as a helpful but stale map.

Closing this gap — codegen plus a CI drift job — is the highest-value
infrastructure work available in this repo.

## Graceful degradation is a product invariant, not a nicety

The service runs with no database and no Redis. Without `DATABASE_URL`
persistence is off and every save/dismiss affordance hides rather than silently
no-opping; without `REDIS_URL` the cache is in-memory. `cargo build` and
`cargo test` are green with neither set.

Never introduce a hard dependency on an optional component. A capability that
cannot be provided is hidden, never broken.

## Where things are

```
backend/src/           handlers, pipeline, scoring, cache, auth, db
backend/migrations/    additive-only SQL, applied on startup
frontend/src/app/      Next app router — page.tsx, layout.tsx, api routes
frontend/src/lib/      domain logic + hooks, each with a colocated *.test.ts
frontend/src/components/
eval/                  offline temporal-holdout harness (Python)
docs/                  diátaxis-named: reference-, howto-, explanation-, spike-, roadmap-
```

## Read before you build

- `docs/roadmap.md` and `docs/roadmap-10x-2026-07-02.md` — what is next and why
- `docs/explanation-scoring.md` — how the ranking actually works
- `docs/reference-schema.md` — the persistence model
- `eval/README.md` — how a scoring claim gets validated before it ships

## Scratch space

Rough work goes in the repo-local `tmp/`, which is gitignored. Session artifacts
that already exist at the root — `design-after*/`, `qa-*/`, `design-*.html`,
screenshots — are gitignored too and are local-only by design; leave them alone
unless asked.

## Verification

Each lane's brief lists the commands that constitute "done" for that lane. Run
the ones that cover what you touched, and name which you ran and which you only
reasoned about.
