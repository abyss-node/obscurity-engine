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
        tags_to_derive=args.tags_to_derive,
        tags_per_seed_derive=args.tags_per_seed_derive,
        tag_artists_limit=args.tag_artists_limit,
        xval_genre_overlap=args.xval_genre_overlap,
        xval_overlap_min_tags=args.xval_overlap_min_tags,
        use_match_weight=args.use_match_weight,
        genre_relative_ceiling=args.genre_relative_ceiling,
        genre_ceiling_pctl=args.genre_ceiling_pctl,
        genre_ceiling_min_n=args.genre_ceiling_min_n,
        two_hop=args.two_hop,
        two_hop_expand=args.two_hop_expand,
        threshold_model=args.threshold,
        personalize_appetite=not args.no_personalize_appetite,
        backstop_pctl=args.backstop_pctl,
        backstop_mult=args.backstop_mult,
        backstop_floor=args.backstop_floor,
        backstop_cap=args.backstop_cap,
        appetite_max=args.appetite_max,
        global_appetite=args.global_appetite,
        novelty_model=args.novelty_model,
        underexplored_mult=args.underexplored_mult,
        temporal_seed_weighting=args.temporal_seed_weighting,
        recency_days=args.recency_days,
        recency_boost=args.recency_boost,
        concurrency=args.concurrency,
    )
    anchor = anchor_ts(args.anchor)
    cohort = load_cohort(args)
    cache = Cache(CACHE_PATH, enabled=not args.no_cache)

    print(f"\n  cohort: {len(cohort)} users | k={cfg.k} | threshold={cfg.threshold_model} | "
          f"novelty={cfg.novelty_model} | match_weight={cfg.use_match_weight} | "
          f"two_hop={cfg.two_hop} | cache={'off' if args.no_cache else 'on'}")
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
           f"{'reach':>6} {'R@k':>6} {'P@k':>6} {'MRR':>6} {'obsc@k':>7} {'mean_lst':>9} "
           f"{'xval':>5} {'xvLst':>8} {'xvHit':>5}")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for user, m, skipped in rows:
        if skipped:
            print(f"  {user:<16} — {skipped}")
            continue
        print(f"  {user:<16} {m['adopted']:>5} {m['eligible']:>5} {m['in_pool']:>5} {m['hits']:>4} "
              f"{m['reach']:>6.2f} {m['recall@k']:>6.3f} {m['precision@k']:>6.3f} {m['mrr']:>6.3f} "
              f"{m['obscurity_weighted@k']:>7.3f} {m['mean_listeners']:>9.0f} "
              f"{m['xval_count']:>5} {m['xval_mean_listeners']:>8.0f} {m['xval_hits']:>5}")

    agg = aggregate(per_user_metrics)
    if agg:
        print("  " + "-" * (len(hdr) - 2))
        print(f"  {'MEAN (' + str(len(per_user_metrics)) + ')':<16} {'':>5} {'':>5} {'':>5} {'':>4} "
              f"{agg['reach']:>6.2f} {agg['recall@k']:>6.3f} {agg['precision@k']:>6.3f} {agg['mrr']:>6.3f} "
              f"{agg['obscurity_weighted@k']:>7.3f} {agg['mean_listeners']:>9.0f} "
              f"{agg['xval_count']:>5.1f} {agg['xval_mean_listeners']:>8.0f} {agg['xval_hits']:>5.2f}")
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
    _d0 = Config()  # default values for arg help/defaults
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
    # cross-validation de-biasing levers
    p.add_argument("--tags-to-derive", type=int, default=_d0.tags_to_derive,
                   help="lever 1: how many genre tags to derive for cross-validation (live=3)")
    p.add_argument("--tags-per-seed-derive", type=int, default=_d0.tags_per_seed_derive,
                   help="lever 1: how many of each top-seed's own tags feed the tally (live=3)")
    p.add_argument("--tag-artists-limit", type=int, default=_d0.tag_artists_limit,
                   help="lever 2: top-N artists fetched per derived tag (live=100)")
    p.add_argument("--xval-genre-overlap", action="store_true",
                   help="lever 3: also cross-validate when a candidate's own tags overlap the "
                        "seed-genre profile (popularity-neutral)")
    p.add_argument("--xval-overlap-min-tags", type=int, default=_d0.xval_overlap_min_tags,
                   help="lever 3: min overlapping profile tags to count as cross-validated")
    p.add_argument("--use-match-weight", action="store_true",
                   help="backlog #1: weight conviction by getSimilar match score")
    p.add_argument("--two-hop", action="store_true",
                   help="backlog #3: expand candidates one extra hop (similar-of-similar)")
    p.add_argument("--two-hop-expand", type=int, default=60,
                   help="how many top 1-hop candidates to expand a 2nd hop")
    p.add_argument("--threshold", "--threshold-model", dest="threshold",
                   choices=["flat", "true_fans", "discovery"], default="flat",
                   help="obscurity threshold model (flat 25K | per-user true-fans | discovery)")
    p.add_argument("--no-personalize-appetite", action="store_true",
                   help="discovery A/B: use global_appetite instead of per-user inferred appetite")
    # discovery backstop / appetite levers (defaults mirror Config)
    _d = Config()
    p.add_argument("--genre-relative-ceiling", action="store_true",
                   help="backlog #2: flat-mode ceiling = per-genre listener percentile "
                        "(thin/untagged genres fall back to the absolute ceiling)")
    p.add_argument("--genre-ceiling-pctl", type=float, default=_d.genre_ceiling_pctl,
                   help="backlog #2: per-genre listener percentile used as the ceiling")
    p.add_argument("--genre-ceiling-min-n", type=int, default=_d.genre_ceiling_min_n,
                   help="backlog #2: min pool artists in a genre to trust its percentile")
    p.add_argument("--backstop-pctl", type=float, default=_d.backstop_pctl,
                   help="discovery: seed-listener percentile for the per-user backstop")
    p.add_argument("--backstop-mult", type=float, default=_d.backstop_mult,
                   help="discovery: multiplier on the seed-percentile backstop")
    p.add_argument("--backstop-floor", type=int, default=_d.backstop_floor,
                   help="discovery: minimum backstop even for very obscure users")
    p.add_argument("--backstop-cap", type=int, default=_d.backstop_cap,
                   help="discovery: absolute ceiling on the per-user backstop (0 = off)")
    p.add_argument("--appetite-max", type=float, default=_d.appetite_max,
                   help="discovery: obscurity bias for fully-obscure taste (tilt strength upper bound)")
    p.add_argument("--global-appetite", type=float, default=_d.global_appetite,
                   help="discovery: tilt strength when personalize-appetite is off / shrinkage prior")
    p.add_argument("--novelty-model", choices=["strict", "underexplored"], default=_d.novelty_model,
                   help="strict: exclude all past-known artists | underexplored: artists with fewer "
                        "plays than the user's mean plays-per-artist stay recommendable, and "
                        "re-engaging with them counts as adoption")
    p.add_argument("--underexplored-mult", type=float, default=_d.underexplored_mult,
                   help="underexplored threshold = mean plays-per-artist × this multiplier")
    p.add_argument("--temporal-seed-weighting", action="store_true",
                   help="backlog #4: blend all-time seed weight with a recency multiplier "
                        "so recent listening tilts both seed selection and conviction weighting")
    p.add_argument("--recency-days", type=int, default=_d.recency_days,
                   help="recent sub-window (days back from cutoff) for temporal seed weighting")
    p.add_argument("--recency-boost", type=float, default=_d.recency_boost,
                   help="weight *= 1 + recency_boost * (recent_plays / total_plays)")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--json", help="write full results to this path")
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
