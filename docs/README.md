# Obscurity Engine documentation

Structured with the [Diátaxis](https://diataxis.fr) framework — four kinds of
docs for four reader needs.

## Start here

- **New to the app?** → [Tutorial: find your next favorite artist](tutorial-getting-started.md)
- **Want to understand the engine?** → [How it works](explanation-how-it-works.md)
- **Running or deploying it?** → [Run locally](howto-run-locally.md) · [Deploy](howto-deploy.md)

## All docs

### Tutorials (learning-oriented)
- [Getting started](tutorial-getting-started.md) — run a discovery and read the results, end to end.

### How-to guides (task-oriented)
- [Run locally](howto-run-locally.md) — backend + frontend on your machine.
- [Deploy](howto-deploy.md) — Railway + Vercel (and the `railway up` gotcha).

### Reference (information-oriented)
- [HTTP API](reference-api.md) — endpoints, parameters, response schema, caching, errors.
- [Database schema](reference-schema.md) — Postgres tables for identity, events, and observations (Phase 1).
- [Eval harness](reference-eval-harness.md) — measuring scoring changes before shipping.

### Explanation (understanding-oriented)
- [How it works](explanation-how-it-works.md) — the four-stage discovery pipeline.
- [The scoring model](explanation-scoring.md) — conviction, stickiness, cross-validation, the obscurity index.
- [Privacy](explanation-privacy.md) — what's stored, when, and how to export or delete it.
- [Roadmap](roadmap.md) — north star, queued work, and experiments tried.

## Also in the repo

- [`../README.md`](../README.md) — project overview & quick start.
- [`../DESIGN.md`](../DESIGN.md) — design system (tokens, fonts, rules).
