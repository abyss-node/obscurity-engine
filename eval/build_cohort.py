"""Cohort builder — snowball the Last.fm friend graph and vet eval suitability.

BFS out from seed users via user.getFriends, vet each candidate, and emit a
cohort of users that can actually be evaluated (deep history + active through
the holdout window). Vetting is cheap (~3 calls/candidate) and cached.

Single-seed (original behaviour):
    python build_cohort.py --seeds Arnuv_J --target 25
    python build_cohort.py --seeds Arnuv_J --target 25 --write

Multi-seed de-biased cohort (each root snowballed independently):
    python build_cohort.py --seeds Arnuv_J,hirenrevolver,stationinmyroom \\
        --friends-per-user 8 --max-per-root 10 --out cohort_debiased.txt

Bias note: friend-snowball clusters around the seeds' taste.  When multiple
seeds are given each root is snowballed INDEPENDENTLY and contributions are
capped at --max-per-root so no single cluster dominates.
"""
from __future__ import annotations
import argparse
import asyncio
import pathlib

import config
from cache import Cache
from config import CACHE_PATH, Config, anchor_ts
from lastfm import LastfmClient

ROOT = pathlib.Path(__file__).resolve().parent


async def vet(client: LastfmClient, user: str, cfg: Config, anchor: int, min_playcount: int):
    """Returns (status, info). status in {ok, young, thin, dormant, missing}."""
    info = await client.user_info(user)
    if not info:
        return "missing", None

    cutoff = anchor - cfg.future_days * 86400
    past_from = cutoff - cfg.past_days * 86400

    if info["registered"] == 0 or info["registered"] > past_from:
        return "young", info          # no seed window before the split
    if info["playcount"] < min_playcount:
        return "thin", info           # not enough history to seed from

    # active through the holdout: any dated scrobble in [cutoff, anchor]
    rt = await client.recent_tracks(user, cutoff, anchor, 1)
    tracks = rt.get("recenttracks", {}).get("track", [])
    if isinstance(tracks, dict):
        tracks = [tracks]
    if not any("date" in t for t in tracks):
        return "dormant", info        # no ground truth to hit

    return "ok", info


# ---------------------------------------------------------------------------
# Single-root snowball (used both in single-seed mode and per-root in
# multi-seed mode).
# ---------------------------------------------------------------------------

async def _snowball_root(
    root: str,
    cfg: Config,
    anchor: int,
    args,
    *,
    already_seen: set[str],
    label: str = "",
) -> list[str]:
    """BFS snowball from *root*, return up to args.max_per_root vetted users.

    *already_seen* is mutated in-place so callers can exclude users already
    claimed by a previous root (cross-root de-duplication).
    """
    seen: set[str] = set(already_seen) | {root}
    queue: list[str] = [root]
    vetted: list[str] = []
    examined = 0

    expand = not args.direct
    target = args.target
    max_per_root = getattr(args, "max_per_root", None)
    if max_per_root is not None:
        target = min(target, max_per_root)

    header = f"  [{label}] " if label else "  "
    if args.direct:
        # cohort = root + its direct friends (no recursion)
        async with LastfmClient(cfg.cache if hasattr(cfg, "cache") else None,
                                cfg.concurrency) as c0:
            fl = await c0.user_friends(root, args.friends_per_user)
        for f in fl:
            if f not in seen:
                seen.add(f)
                queue.append(f)
        print(f"\n{header}direct friends of {root}: {len(queue)} users to vet | "
              f"min_playcount {args.min_playcount}\n")
    else:
        print(f"\n{header}snowball from {root} | target {target} vetted | "
              f"min_playcount {args.min_playcount}\n")

    print(f"  {'user':<22} {'status':<8} {'playcount':>10}")
    print("  " + "-" * 42)

    async with LastfmClient(args._cache, cfg.concurrency) as client:
        _target = 10**9 if args.direct else target
        _max_examine = max(args.max_examine, 2000) if args.direct else args.max_examine
        while queue and len(vetted) < _target and examined < _max_examine:
            batch = queue[: cfg.concurrency]
            queue = queue[cfg.concurrency:]
            results = await asyncio.gather(
                *(vet(client, u, cfg, anchor, args.min_playcount) for u in batch)
            )
            friend_lists = await asyncio.gather(
                *(client.user_friends(u, args.friends_per_user) for u in batch)
            ) if expand else []
            for user, (status, info) in zip(batch, results):
                examined += 1
                pc = info["playcount"] if info else 0
                print(f"  {user:<22} {status:<8} {pc:>10,}")
                if status == "ok" and user not in already_seen:
                    vetted.append(user)
                    already_seen.add(user)   # claim across roots
                    if max_per_root is not None and len(vetted) >= max_per_root:
                        break
            for friends in friend_lists:
                for f in friends:
                    if f not in seen:
                        seen.add(f)
                        queue.append(f)

    print("  " + "-" * 42)
    print(f"\n  [{root}] vetted {len(vetted)} / examined {examined} "
          f"(queue had {len(queue)} more)\n")
    return vetted


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

async def main_async(args) -> None:
    cfg = Config()
    cache = Cache(CACHE_PATH)
    # Stash cache on args so _snowball_root can reach it without threading cfg.
    args._cache = cache
    anchor = anchor_ts(args.anchor)
    seeds = [s.strip() for s in args.seeds.split(",") if s.strip()]

    multi_root = len(seeds) > 1 and not args.direct

    if not multi_root:
        # ----------------------------------------------------------------
        # ORIGINAL single-seed path (behaviour unchanged)
        # ----------------------------------------------------------------
        seen: set[str] = set(seeds)
        queue: list[str] = list(seeds)
        vetted: list[str] = []
        examined = 0
        expand = not args.direct
        if args.direct:
            args.target = 10**9
            args.max_examine = max(args.max_examine, 2000)

        if args.direct:
            async with LastfmClient(cache, cfg.concurrency) as c0:
                fl = await asyncio.gather(*(c0.user_friends(s, args.friends_per_user) for s in seeds))
            for friends in fl:
                for f in friends:
                    if f not in seen:
                        seen.add(f)
                        queue.append(f)
            print(f"\n  direct friends of {len(seeds)} seed(s): {len(queue)} users to vet | "
                  f"min_playcount {args.min_playcount}\n")
        else:
            print(f"\n  snowball from {len(seeds)} seeds | target {args.target} vetted | "
                  f"min_playcount {args.min_playcount}\n")
        print(f"  {'user':<22} {'status':<8} {'playcount':>10}")
        print("  " + "-" * 42)

        async with LastfmClient(cache, cfg.concurrency) as client:
            while queue and len(vetted) < args.target and examined < args.max_examine:
                batch = queue[: cfg.concurrency]
                queue = queue[cfg.concurrency:]
                results = await asyncio.gather(
                    *(vet(client, u, cfg, anchor, args.min_playcount) for u in batch)
                )
                friend_lists = await asyncio.gather(
                    *(client.user_friends(u, args.friends_per_user) for u in batch)
                ) if expand else []
                for user, (status, info) in zip(batch, results):
                    examined += 1
                    pc = info["playcount"] if info else 0
                    print(f"  {user:<22} {status:<8} {pc:>10,}")
                    if status == "ok":
                        vetted.append(user)
                for friends in friend_lists:
                    for f in friends:
                        if f not in seen:
                            seen.add(f)
                            queue.append(f)

        print("  " + "-" * 42)
        print(f"\n  vetted {len(vetted)} / examined {examined} (queue had {len(queue)} more):\n")
        print("  " + ", ".join(vetted) + "\n")

        if args.write and vetted:
            # Single-seed write: honour --out if provided, else cohort.txt
            out_path = ROOT / args.out if args.out != "cohort_debiased.txt" else ROOT / "cohort.txt"
            _append_to_cohort(out_path, vetted)

    else:
        # ----------------------------------------------------------------
        # MULTI-ROOT de-biased path
        # ----------------------------------------------------------------
        print(f"\n  multi-root snowball | {len(seeds)} roots | "
              f"friends-per-user {args.friends_per_user} | "
              f"max-per-root {args.max_per_root} | "
              f"target {args.target} total\n")

        all_vetted: list[str] = []
        claimed: set[str] = set(seeds)   # never re-attribute seeds across roots

        for root in seeds:
            root_vetted = await _snowball_root(
                root,
                cfg,
                anchor,
                args,
                already_seen=claimed,
                label=root,
            )
            all_vetted.extend(root_vetted)
            if len(all_vetted) >= args.target:
                print(f"  global target {args.target} reached, stopping early.\n")
                break

        print(f"\n  === de-biased cohort: {len(all_vetted)} users from {len(seeds)} roots ===\n")
        print("  " + ", ".join(all_vetted) + "\n")

        if args.write and all_vetted:
            out_path = ROOT / args.out
            _append_to_cohort(out_path, all_vetted)


def _append_to_cohort(path: pathlib.Path, vetted: list[str]) -> None:
    existing: set[str] = set()
    if path.exists():
        existing = {
            ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.startswith("#")
        }
    new = [u for u in vetted if u not in existing]
    with path.open("a", encoding="utf-8") as fh:
        for u in new:
            fh.write(u + "\n")
    print(f"  appended {len(new)} new users to {path}\n")


def main() -> None:
    p = argparse.ArgumentParser(description="Build a vetted eval cohort via friend-graph snowball")
    p.add_argument("--seeds", required=True, help="comma-separated seed usernames")
    p.add_argument("--target", type=int, default=25, help="how many vetted users to collect (total)")
    p.add_argument("--min-playcount", type=int, default=5000)
    p.add_argument("--friends-per-user", type=int, default=50,
                   help="cap friends pulled from any single user during snowball (default 50; "
                        "consider --friends-per-user 8-10 for multi-root runs to limit API calls)")
    p.add_argument("--max-per-root", type=int, default=12,
                   help="max vetted users any single seed root may contribute (multi-root mode only)")
    p.add_argument("--max-examine", type=int, default=400, help="hard cap on candidates probed")
    p.add_argument("--anchor", default="2026-06-10")
    p.add_argument("--direct", action="store_true",
                   help="cohort = seeds + their direct friends only (no friend-of-friend recursion)")
    p.add_argument("--out", default="cohort_debiased.txt",
                   help="output file for --write in multi-root mode (default: cohort_debiased.txt); "
                        "single-seed --write still uses cohort.txt unless you pass a different --out")
    p.add_argument("--write", action="store_true",
                   help="append vetted users to the output file (--out or cohort.txt for single-seed)")
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
