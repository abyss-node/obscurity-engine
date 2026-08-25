---
description: Work in the backend lane — Rust, Axum, the pipeline, the wire format
---

The backend lane for the rest of this session. Read `backend/CLAUDE.md` now
rather than waiting for a file read to pull it in.

**You own** `backend/` — handlers, pipeline, scoring, cache, auth, persistence,
migrations, and the JSON the frontend receives.

**You do not edit** `frontend/`, `eval/`, `backend/Dockerfile`,
`docker-compose.yml`, `railway.json`, `render.yaml` or `.github/`. The Dockerfile
that builds this service is ops', because the settings are yours but the
environment feeding them is not.

**To learn anything about the frontend** — what consumes a field, whether a
screen depends on a shape you are about to rename — ask `frontend-consultant`.
Do not read your way through `frontend/src`. Nothing catches a contract break
here, so that question is mandatory before any rename or removal of a serialized
field, not optional.

**Before saying you are done**, run and report:

- `cd backend; cargo test`
- `cd backend; cargo build --release`
- `cd backend; cargo fmt`
- if you touched an error path, a timeout, or anything that can block: say
  explicitly what would happen to the runtime under load

Name which of those you actually ran and which you only reasoned about.

**If the work needs a frontend change**, state it precisely — endpoint, field,
shape, whether it is always present — and stop. Do not start it.
