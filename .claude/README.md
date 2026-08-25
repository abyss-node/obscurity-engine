# Claude Code configuration

Deliberately small. Every entry is loaded or considered on some session, so a
speculative agent or command costs attention without earning it. Add one when a
task has been done badly twice, not in anticipation.

## The lane model

Four lanes — backend, frontend, eval, ops. The two shipping stacks share no
tooling and no idiom: Rust, cargo and tokio against Next, npm and vitest. A
session told to hold both behaves as a generalist across two specialisms. Eval is
a third: Python, statistics, and nothing that ships. Ops is a role rather than a
directory.

| File | Loaded | Holds |
|---|---|---|
| `CLAUDE.md` | every session | what is true of every lane, and the undefended contract |
| `backend/CLAUDE.md` | when a file under `backend/` is touched | the backend invariants |
| `frontend/CLAUDE.md` | when a file under `frontend/` is touched | the frontend invariants |
| `eval/CLAUDE.md` | when a file under `eval/` is touched | the evidence discipline |
| `commands/{backend,frontend,eval,ops}.md` | when run | the role — what it owns, what it never touches, what "done" means |

**A rule has one home.** The nested files load automatically but *late*, only
once a file in that subtree is read. A role command puts the hat on at the top of
the session instead. Having both is the point: the invariants cannot be skipped
by an unhatted session, and the lane rules arrive before the first edit rather
than after it.

## Inventory

`agents/`

- `backend-consultant`, `frontend-consultant` — read-only, `Read`/`Grep`/`Glob`
  and nothing else. They exist here rather than deferring to the global
  `consultant` because each knows something no general agent could: the backend
  one knows that `models.rs` is the contract and that `docs/reference-api.md` is
  stale as of 2026-07-03, and that serde presence is decided by
  `skip_serializing_if` rather than `default`. The frontend one knows it is the
  *only* check on a rename, since nothing mechanical defends the contract.

`commands/`

- `backend`, `frontend`, `eval`, `ops` — the role briefs. No `/release`: the
  global `/checkpoint` covers commit-time verification, and there is no release
  ritual to encode while production is down.

There is no ops consultant. The surface is a compose file, two Dockerfiles, two
deploy manifests and one workflow — readable in a single pass.

## The failure each entry exists for

- **The lane split** — a window spent reading Rust from a React session, or the
  reverse, is a window not spent on the work.
- **The consultants** — the Rust/TypeScript contract is hand-mirrored with no
  codegen and no CI drift job, so a rename breaks a screen at runtime with every
  build green. Asking is the only defence.
- **`eval/CLAUDE.md`** — a 2026-06-22 re-run at n=348 reversed conclusions drawn
  at n=54. Results reported without n and an anchor date have already misled once.
- **`/ops` stating the real deploy state** — production has been down since
  roughly 2026-07-09 on an exhausted Railway trial, and the only workflow is a
  keep-warm ping. A session that assumes a working pipeline will report success
  that did not happen.

## Known gaps, recorded rather than fixed

These are real and none of them is addressed by configuration. Each is worth more
than any further tuning of these files:

1. **No contract codegen and no CI drift job.** The highest-value infrastructure
   work available in this repo. Still open.
2. ~~No CI beyond keep-warm.~~ **Closed 2026-08-25.** `ci.yml` runs `cargo test`,
   `npm run typecheck`, `npm run test` and `npm run build`, path-filtered.
3. **Clippy and rustfmt are advisory, not blocking.** The tree has 14 clippy
   warnings and real rustfmt drift, so they run with `continue-on-error` rather
   than shipping a CI that is red on arrival. Flip them to blocking in the
   commit that cleans them up.
4. **No ESLint config at all.** `next lint` drops into an interactive setup
   prompt and is deprecated in Next 15, so CI has no lint step. Nothing refuses
   a dated construct on the frontend either.
5. **`next.config.js` disables both type and lint checking at build time**
   (`ignoreBuildErrors`, `ignoreDuringBuilds`). `npm run typecheck` — added
   2026-08-25 — is now the only type gate. Turning the config flags off is
   worth doing once clippy and ESLint are in place.
6. **`docs/reference-api.md` is stale** — omits `ytd`, still says MIX.
7. **Error `code` is the HTTP status**, so a client cannot distinguish two
   different 503s without matching English prose.
8. **The boot-time database connect uses the 1s request-path timeout**
   (`db.rs:40`), which a cold Neon compute cannot meet — and migrations are
   attempted exactly once at boot with no retry. See the deploy notes in
   `/ops`.
