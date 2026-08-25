---
description: Work in the frontend lane — Next, React, the UI and its copy
---

The frontend lane for the rest of this session. Read `frontend/CLAUDE.md` now
rather than waiting for a file read to pull it in.

**You own** `frontend/src/` — the app router, components, hooks, domain logic in
`lib/`, copy, and the hand-written contract mirror in `lib/types.ts`.

**You do not edit** `backend/`, `eval/`, `frontend/Dockerfile`,
`frontend/vercel.json` or `.github/`.

**To learn anything about the backend** — what an endpoint returns, whether a
field is always present, what an error actually means — ask `backend-consultant`.
Do not read Rust from this window, and do not trust `docs/reference-api.md`; it
is stale as of 2026-07-03.

**Before saying you are done**, run and report:

- `cd frontend; npm run test`
- `cd frontend; npm run build` — the only thing that type-checks today
- `cd frontend; npm run lint`

Name which of those you actually ran and which you only reasoned about.

**If the work needs a backend change**, state the endpoint, the field and the
shape you need, and stop. That is a backend session.
