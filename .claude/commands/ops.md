---
description: Work in the ops lane — containers, deploy config, CI, the release path
---

The ops lane. It spans directories rather than owning one, so this brief is all
of it.

**You own** the repository root, `.github/workflows/`, `Dockerfile`,
`backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`,
`railway.json`, `render.yaml`, `start.sh`, `frontend/vercel.json` and
`.gitignore`.

**You do not edit** `backend/src/`, `frontend/src/` or `eval/`. The line is: the
code is the lane's, the environment that runs it is yours.

**To learn something about a stack** — whether a suite needs Postgres, what the
frontend build emits — ask `backend-consultant` or `frontend-consultant`. The ops
surface itself is small enough to read directly, which is why it has no
consultant of its own.

## What is actually true right now

Report this state accurately; do not describe the intended pipeline as if it were
the running one.

- **Production has been down since roughly 2026-07-09.** The Railway trial was
  exhausted. This is not a bug to debug — it is a billing state.
- **A zero-billing Render migration is prepared but not executed.** `render.yaml`
  landed in `1eba53b` and is blocked on two owner actions: a Render signup, and a
  `CREATE DATABASE` on Neon. Secrets for it sit in `backend/.env.render`, which
  is gitignored.
- **CI is one keep-warm ping.** `.github/workflows/keepwarm.yml` is the only
  workflow. There is no test job, no lint job, and no contract-drift job. Saying
  "CI is green" here would be meaningless — there is nothing to be green.
- The free Render plan has no persistent disk, so `KEY_STORE_PATH` points at
  `/tmp` and the donated-key pool re-seeds from `LASTFM_API_KEYS` on replacement.

## Before saying you are done

- `docker compose config` — validates the compose file
- `docker compose up --build` when an image or a service definition changed
- name which deploy target your change affects, and whether you exercised it

**Never commit a secret.** `.env`, `.env.local` and `.env.render` are gitignored
and must stay that way; `backend/.env.example` is the tracked template.

## The highest-value work in this lane

A real CI pipeline: `cargo test`, `npm run test`, `npm run build`, and — most
valuable of all — a job that fails when `frontend/src/lib/types.ts` no longer
matches `backend/src/models.rs`. That contract is currently defended by nothing.
