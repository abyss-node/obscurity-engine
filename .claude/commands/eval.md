---
description: Work in the eval lane — the offline scoring harness. Ships nothing
---

The eval lane for the rest of this session. Read `eval/CLAUDE.md` now.

**You own** `eval/` — the Python port of the pipeline, the temporal-holdout
evaluator, cohort building, metrics and the result artefacts.

**You edit nothing else.** This lane produces evidence, not shipped code. A
finding here becomes a Rust change in a separate backend session.

**Before reporting a result**, state all of:

- the variant, the baseline it is against, and the exact commands run
- **n**, and the anchor date
- the paired-bootstrap interval, not just the point difference
- whether `obscurity_weighted@k` moved, not only raw hits

**A null result is a result.** Say so plainly. Most variants tested here have
been honest losses, and reporting only wins is how a harness stops being worth
running.

Name which commands you actually ran and which you only reasoned about.
