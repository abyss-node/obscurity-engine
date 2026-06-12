"""Offline eval harness entrypoint.

    python harness.py --users alice,bob --k 20
    python harness.py --cohort cohort.txt --use-match-weight   # A/B backlog item #1
    python harness.py --users alice --no-cache                 # force fresh fetch

First run on a cohort pays the Last.fm API cost; every re-run is cache-fast.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import pathlib

from cache import Cache
from config import API_KEY, CACHE_PATH, Config, anchor_ts  # noqa: F401  (API_KEY validates early)
from lastfm import LastfmClient
from metrics import aggregate, evaluate
from pipeline import run_user

ROOT = pathlib.Path(__file__).resolve().parent


def load_cohort(args) -> list[str]:
    if args.users:
        return [u.strip() for u in args.users.split(",") if u.strip()]
    path = ROOT / args.cohort
    if not path.exists():
        raise SystemExit(f"cohort file not found: {path}")
    return [
        ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    ]


async def main_async(args) -> None:
    cfg = Config(
        k=args.k,
        future_days=args.future_days,
        past_days=args.past_days,
        max_candidates=args.max_candidates,
        use_match_weight=args.use_match_weight,
        two_hop=args.two_hop,
        two_hop_expand=args.two_hop_expand,
        threshold_model=args.threshold,
        concurrency=args.concurrency,
    )
    anchor = anchor_ts(args.anchor)
    cohort = load_cohort(args)
    cache = Cache(CACHE_PATH, enabled=not args.no_cache)

    print(f"\n  cohort: {len(cohort)} users | k={cfg.k} | threshold={cfg.threshold_model} | "
          f"match_weight={cfg.use_match_weight} | two_hop={cfg.two_hop} | cache={'off' if args.no_cache else 'on'}")
    print(f"  split: seeds=[-{cfg.past_days}d] holdout=[{cfg.future_days}d] anchored at {args.anchor}\n")

    per_user_metrics = []
    rows = []
    async with LastfmClient(cache, cfg.concurrency) as client:
        results = await asyncio.gather(*(run_user(client, u, anchor, cfg) for u in cohort))

    for res in results:
        if "skipped" in res:
            rows.append((res["user"], None, res["skipped"]))
            continue
        m = evaluate(res["ranked"], res, cfg.k)
        per_user_metrics.append(m)
        rows.append((res["user"], m, None))

    # ── report: funnel (adopted→eligible→in_pool→hit) then ranking metrics ─────
    hdr = (f"  {'user':<16} {'adopt':>5} {'elig':>5} {'pool':>5} {'hit':>4} "
           f"{'reach':>6} {'R@k':>6} {'P@k':>6} {'MRR':>6} {'obsc@k':>7} {'mean_lst':>9}")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for user, m, skipped in rows:
        if skipped:
            print(f"  {user:<16} — {skipped}")
            continue
        print(f"  {user:<16} {m['adopted']:>5} {m['eligible']:>5} {m['in_pool']:>5} {m['hits']:>4} "
              f"{m['reach']:>6.2f} {m['recall@k']:>6.3f} {m['precision@k']:>6.3f} {m['mrr']:>6.3f} "
              f"{m['obscurity_weighted@k']:>7.3f} {m['mean_listeners']:>9.0f}")

    agg = aggregate(per_user_metrics)
    if agg:
        print("  " + "-" * (len(hdr) - 2))
        print(f"  {'MEAN (' + str(len(per_user_metrics)) + ')':<16} {'':>5} {'':>5} {'':>5} {'':>4} "
              f"{agg['reach']:>6.2f} {agg['recall@k']:>6.3f} {agg['precision@k']:>6.3f} {agg['mrr']:>6.3f} "
              f"{agg['obscurity_weighted@k']:>7.3f} {agg['mean_listeners']:>9.0f}")
    print(f"\n  cache entries: {cache.stats()}\n")

    if args.json:
        out = {
            "config": vars(cfg),
            "anchor": args.anchor,
            "per_user": [
                {"user": u, "metrics": m, "skipped": s} for (u, m, s) in rows
            ],
            "aggregate": agg,
        }
        pathlib.Path(args.json).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"  wrote {args.json}\n")


def main() -> None:
    p = argparse.ArgumentParser(description="Obscurity Engine offline eval harness")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--users", help="comma-separated Last.fm usernames")
    g.add_argument("--cohort", default="cohort.txt", help="file with one username per line")
    p.add_argument("--k", type=int, default=20)
    p.add_argument("--future-days", type=int, default=180)
    p.add_argument("--past-days", type=int, default=365)
    p.add_argument("--max-candidates", type=int, default=300)
    p.add_argument("--anchor", default="2026-06-10", help="reference 'now' (YYYY-MM-DD)")
    p.add_argument("--concurrency", type=int, default=5)
    p.add_argument("--use-match-weight", action="store_true",
                   help="backlog #1: weight conviction by getSimilar match score")
    p.add_argument("--two-hop", action="store_true",
                   help="backlog #3: expand candidates one extra hop (similar-of-similar)")
    p.add_argument("--two-hop-expand", type=int, default=60,
                   help="how many top 1-hop candidates to expand a 2nd hop")
    p.add_argument("--threshold", choices=["flat", "true_fans"], default="flat",
                   help="obscurity threshold model (flat 25K vs per-user true-fans)")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--json", help="write full results to this path")
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
