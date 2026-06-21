"""Ranking metrics for the temporal holdout.

A recommendation is a HIT if the artist is in the user's ground-truth set
(adopted, recurring, in the holdout window, not known before). Absolute recall
is low by nature — users discover music from many sources, not just an algorithm
— so read these as RELATIVE numbers for comparing scoring variants, not as a
quality score. The obscurity-weighted hit rate is the one that tracks the actual
product goal: surfacing *obscure* artists that land.
"""
from __future__ import annotations

import random

CEILING = 25_000


def evaluate(ranked: list[dict], result: dict, k: int) -> dict:
    """result is run_user's dict: ground_truth / eligible / in_pool sets.

    Recall is measured against ELIGIBLE (under-ceiling) ground truth, since the
    engine is structurally barred from recommending anything above the ceiling —
    counting those in the denominator would penalise it for the filter by design.
    The funnel (adopted → eligible → in_pool → hit) localises where users are
    lost: a low in_pool/eligible ratio is a REACH problem, a low hit/in_pool
    ratio is a RANKING problem.
    """
    ground_truth = result["ground_truth"]
    eligible = result["eligible"]
    in_pool = result["in_pool"]

    topk = ranked[:k]
    hit_idx = [i for i, r in enumerate(topk) if r["norm"] in ground_truth]
    hits = len(hit_idx)

    n_elig = len(eligible)
    precision = hits / k if k else 0.0
    recall = hits / n_elig if n_elig else 0.0
    mrr = 1.0 / (hit_idx[0] + 1) if hit_idx else 0.0
    hit_at_k = 1.0 if hits else 0.0

    ow = sum(
        max(0.0, 1.0 - min(topk[i]["listeners"], CEILING) / CEILING) for i in hit_idx
    )
    ow_per_k = ow / k if k else 0.0
    mean_listeners = sum(r["listeners"] for r in topk) / len(topk) if topk else 0.0

    # listener counts of the hit artists, so "obscure hits" (≤CEILING) can be
    # counted per run without re-fetching anything downstream.
    hit_listeners = [topk[i]["listeners"] for i in hit_idx]
    obscure_hits = sum(1 for l in hit_listeners if l <= CEILING)

    # re-engagement (lightly-known artist the user dug into) vs pure discovery
    # (never heard before) — only meaningful when novelty_model=underexplored.
    gt_reengage = result.get("gt_reengage", set())
    reengage_hits = sum(1 for i in hit_idx if topk[i]["norm"] in gt_reengage)

    # cross-validation (dual-signal) coverage in the top-K + how obscure those
    # dual-signals are. De-biasing should raise the count AND lower mean listeners
    # (more *obscure* artists earning the badge), and ideally lift xval_hits.
    xval = [r for r in topk if r.get("cross_validated")]
    xval_count = len(xval)
    xval_mean_listeners = sum(r["listeners"] for r in xval) / len(xval) if xval else 0.0
    xval_hits = sum(1 for i in hit_idx if topk[i].get("cross_validated"))

    return {
        "hits": hits,
        "adopted": len(ground_truth),
        "eligible": n_elig,
        "in_pool": len(in_pool),
        "reach": len(in_pool) / n_elig if n_elig else 0.0,        # eligible → in_pool
        "precision@k": precision,
        "recall@k": recall,                                       # hits / eligible
        "mrr": mrr,
        "hit_rate@k": hit_at_k,
        "obscurity_weighted@k": ow_per_k,
        "mean_listeners": mean_listeners,
        "obscure_hits": obscure_hits,                             # hits with ≤CEILING listeners
        "hit_listeners": hit_listeners,                           # raw listener counts of hits
        "reengage_hits": reengage_hits,                           # hits that were lightly-known
        "discovery_hits": hits - reengage_hits,                   # hits never heard before
        "adopted_reengage": len(gt_reengage),                     # GT split: light re-engagement
        "adopted_discovery": len(result.get("gt_discovery", result["ground_truth"])),
        "xval_count": xval_count,                                 # dual-signals in top-K
        "xval_mean_listeners": xval_mean_listeners,               # how obscure those dual-signals are
        "xval_hits": xval_hits,                                   # dual-signals that were adopted
    }


def aggregate(per_user: list[dict]) -> dict:
    """Mean of each numeric metric across evaluated users.

    Per-user list-valued fields (e.g. hit_listeners) are skipped — they are
    kept in per_user output for post-hoc analysis, not meaningfully averaged.
    """
    if not per_user:
        return {}
    keys = [k for k, v in per_user[0].items() if isinstance(v, (int, float))]
    return {k: sum(u[k] for u in per_user) / len(per_user) for k in keys}


def confidence_intervals(per_user: list[dict], metric_keys: list[str],
                         n_boot: int = 2000, seed: int = 12345,
                         alpha: float = 0.05) -> dict:
    """Seeded bootstrap 95% CIs on the cohort-mean of each metric.

    Resample users with replacement n_boot times, take the mean each time, and
    read off the [alpha/2, 1-alpha/2] percentiles. Seeded so re-runs are
    reproducible. With ~50 users and a few dozen total hits these intervals are
    WIDE — that's the point: a lever whose CI straddles the baseline isn't a
    real effect, however good its point estimate looks.
    """
    n = len(per_user)
    if n < 2:
        return {k: (float("nan"), float("nan")) for k in metric_keys}
    rng = random.Random(seed)
    cols = {k: [u.get(k, 0.0) for u in per_user] for k in metric_keys}
    boot = {k: [] for k in metric_keys}
    for _ in range(n_boot):
        idx = [rng.randrange(n) for _ in range(n)]
        for k in metric_keys:
            c = cols[k]
            boot[k].append(sum(c[i] for i in idx) / n)
    lo_i = int((alpha / 2) * n_boot)
    hi_i = min(n_boot - 1, int((1 - alpha / 2) * n_boot))
    out = {}
    for k in metric_keys:
        s = sorted(boot[k])
        out[k] = (s[lo_i], s[hi_i])
    return out
