"""Cohort builder — snowball the Last.fm friend graph and vet eval suitability.

BFS out from seed users via user.getFriends, vet each candidate, and emit a
cohort of users that can actually be evaluated (deep history + active through
the holdout window). Vetting is cheap (~3 calls/candidate) and cached.

    python build_cohort.py --seeds Arnuv_J,hirenrevolver,stationinmyroom --target 25
    python build_cohort.py --seeds Arnuv_J --target 25 --write   # append to cohort.txt

Bias note: friend-snowball clusters around the seeds' taste. Seed from a few
DISCONNECTED users across scenes for a less bubbled sample.
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


async def main_async(args) -> None:
    cfg = Config()
    cache = Cache(CACHE_PATH)
    anchor = anchor_ts(args.anchor)
    seeds = [s.strip() for s in args.seeds.split(",") if s.strip()]

    seen: set[str] = set(seeds)
    queue: list[str] = list(seeds)
    vetted: list[str] = []
    examined = 0
    expand = not args.direct
    if args.direct:
        args.target = 10**9          # vet every direct friend, don't stop early
        args.max_examine = max(args.max_examine, 2000)

    if args.direct:
        # cohort = seeds + their direct friends (people you follow), no recursion
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
            # in snowball mode, expand the friend graph from this batch (vetted or
            # not — thin users still have good friends), breadth-first
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
        path = ROOT / "cohort.txt"
        existing = set()
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
    p.add_argument("--target", type=int, default=25, help="how many vetted users to collect")
    p.add_argument("--min-playcount", type=int, default=5000)
    p.add_argument("--friends-per-user", type=int, default=50)
    p.add_argument("--max-examine", type=int, default=400, help="hard cap on candidates probed")
    p.add_argument("--anchor", default="2026-06-10")
    p.add_argument("--direct", action="store_true",
                   help="cohort = seeds + their direct friends only (no friend-of-friend recursion)")
    p.add_argument("--write", action="store_true", help="append vetted users to cohort.txt")
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
