"""T-B — CEGE coverage spike (Phase 0 de-risking).

Question
--------
Does a semantic entity graph (CEGE) contain the artists users actually adopt
that Last.fm's similar-artists graph CANNOT reach? Pre-registered kill
criterion: if reachable coverage < 2x Last.fm reach, feature F8-as-specced dies
and ListenBrainz/blend takes the Phase-3 slot.

What this script does
----------------------
1. Reconstructs, from the EXISTING sqlite cache + the existing eval artifact
   (`eval/under_flat_debiased_n60.json`), the "adopted-but-not-in-pool" artist
   set: the obscurity-ELIGIBLE artists each cohort user adopted in the holdout
   window that Last.fm's similar-graph did NOT surface as a candidate
   (i.e. `eligible - in_pool`, per `eval/metrics.py`'s reach definition
   `reach = in_pool / eligible`). It does this by calling the harness's own
   `run_user` in CACHE-ONLY mode (no network, no writes) with the artifact's
   exact config, so the reconstructed sets match the shipped run. It does NOT
   invoke the full harness (`harness.py`).

2. Discovers CEGE's actual data state (repo at `--cege-root`, default
   `C:/Users/<user>/cege`). V1 was a POC; if `data/` holds only seed SQL stubs
   and no populated graph DB, there is no music graph to test against, so we
   fall back to the honest PROXY: MusicBrainz — the source CEGE's ETL would
   ingest. For a random seeded sample of the missed set we measure, via the
   MusicBrainz web service (rate-limited to <=1 req/s, descriptive User-Agent):
     - PRESENCE: does the artist exist in MusicBrainz?
     - CONNECTIVITY: does it have >=1 artist-artist relationship (a non-island
       node CEGE's relationship graph could route through)?
   Coverage = fraction of the missed set that is present + connected. CEGE's
   potential reach = Last.fm reach + coverage x (missed / eligible). The verdict
   is labelled PROXY-* because presence+degree is an UPPER BOUND on what CEGE
   could actually route to from a user's specific seeds.

Invocation (run from the repo `eval/` dir, where the 3.9 GB cache lives)
------------------------------------------------------------------------
    # Phase A only: reconstruct the missed set, no network
    python spikes/cege_coverage.py --phase a

    # Full spike: reconstruct + MusicBrainz proxy on a seeded 200-artist sample
    python spikes/cege_coverage.py --phase ab --sample 200

    # Override the shared cache location if not at eval/.cache/lastfm.sqlite
    python spikes/cege_coverage.py --phase ab --cache /path/to/lastfm.sqlite

Outputs (under eval/spikes/, committed for reproducibility)
    missed_set.json      the reconstructed adopted-but-not-in-pool artist set
    mb_coverage.json     per-artist MusicBrainz presence/degree + the verdict
Raw MB responses are cached under eval/spikes/.mbcache/ (NOT committed).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import random
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from dataclasses import fields

# ── make the sibling eval modules importable (config, cache, lastfm, pipeline) ─
EVAL_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL_DIR))

from config import Config, anchor_ts  # noqa: E402
from cache import Cache  # noqa: E402
from lastfm import LastfmClient  # noqa: E402
from pipeline import collect_plays, normalize_artist_name, run_user  # noqa: E402

SPIKE_DIR = pathlib.Path(__file__).resolve().parent
DEFAULT_ARTIFACT = EVAL_DIR / "under_flat_debiased_n60.json"
DEFAULT_CACHE = EVAL_DIR / ".cache" / "lastfm.sqlite"
MB_CACHE_DIR = SPIKE_DIR / ".mbcache"

MB_BASE = "https://musicbrainz.org/ws/2"
# MusicBrainz asks for a descriptive UA with contact info and <=1 req/s anon.
MB_USER_AGENT = "ObscurityEngine-CEGE-CoverageSpike/1.0 ( gauravg@deepnative.ai )"
MB_MIN_INTERVAL = 1.1  # seconds between MB requests (polite; <1 req/s)


# ── cache-only client: reads the shared sqlite, never touches the network ──────
class _CacheMiss(Exception):
    pass


class CacheOnlyClient(LastfmClient):
    """LastfmClient that answers every request from the on-disk cache and raises
    on a miss instead of calling Last.fm. Guarantees the spike does no network
    I/O and does not mutate the shared cache."""

    def __init__(self, cache: Cache, concurrency: int = 8):
        super().__init__(cache, concurrency)
        self.hits = 0
        self.misses = 0

    async def _get(self, params: dict) -> dict:
        ck = self._cache_key(params)
        cached = self.cache.get(ck)
        if cached is None:
            self.misses += 1
            raise _CacheMiss(ck)
        self.hits += 1
        return json.loads(cached)


class ReadOnlyCache(Cache):
    """Open the shared sqlite read-only so the spike can never corrupt or grow
    the harness cache. `set` is a no-op."""

    def __init__(self, path: pathlib.Path):
        self.enabled = True
        uri = f"file:{pathlib.Path(path).as_posix()}?mode=ro"
        self.conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        import threading
        self.lock = threading.Lock()

    def set(self, key: str, body: str) -> None:  # noqa: D401 - read-only
        return None


# ── config reconstruction from the shipped artifact ───────────────────────────
def config_from_artifact(artifact: dict) -> Config:
    """Rebuild the exact Config the artifact was produced with so the
    reconstructed ground_truth / eligible / in_pool sets match the shipped run.
    Only known dataclass fields are copied; unknown keys are ignored."""
    cfg = Config()
    field_names = {f.name for f in fields(Config)}
    for k, v in artifact.get("config", {}).items():
        if k in field_names:
            if k == "tier_cuts" and isinstance(v, list):
                v = tuple(v)
            setattr(cfg, k, v)
    return cfg


# ── Phase A: reconstruct the adopted-but-not-in-pool set ───────────────────────
async def reconstruct_missed_set(artifact_path: pathlib.Path, cache_path: pathlib.Path):
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    cfg = config_from_artifact(artifact)
    anchor_str = artifact.get("anchor") or (artifact.get("anchors") or ["2026-06-10"])[0]
    anchor = anchor_ts(anchor_str)

    users = [u["user"] for u in artifact["per_user"] if u.get("metrics") is not None]

    cache = ReadOnlyCache(cache_path)
    client = CacheOnlyClient(cache, concurrency=cfg.concurrency)

    cutoff = anchor - cfg.future_days * 86400

    missed = {}            # norm -> display  (union of eligible - in_pool)
    per_user_rows = []
    tot_elig = tot_pool = 0
    reconstructed = 0
    cache_incomplete = 0

    for user in users:
        try:
            res = await run_user(client, user, anchor, cfg)
        except _CacheMiss:
            cache_incomplete += 1
            continue
        if res is None or "skipped" in res:
            continue
        eligible = res["eligible"]
        in_pool = res["in_pool"]
        user_missed = eligible - in_pool
        # map missed norms -> display names via the (cached) holdout plays
        try:
            plays_after = await collect_plays(client, user, cutoff, anchor, cfg)
        except _CacheMiss:
            cache_incomplete += 1
            continue
        for norm in user_missed:
            disp = plays_after.get(norm, [norm])[0]
            missed.setdefault(norm, disp)
        reconstructed += 1
        tot_elig += len(eligible)
        tot_pool += len(in_pool)
        per_user_rows.append({
            "user": user,
            "eligible": len(eligible),
            "in_pool": len(in_pool),
            "missed": len(user_missed),
        })

    pooled_reach = (tot_pool / tot_elig) if tot_elig else 0.0
    out = {
        "artifact": artifact_path.name,
        "anchor": anchor_str,
        "users_in_artifact": len(users),
        "users_reconstructed": reconstructed,
        "users_cache_incomplete": cache_incomplete,
        "cache_hits": client.hits,
        "cache_misses": client.misses,
        "pooled_eligible": tot_elig,
        "pooled_in_pool": tot_pool,
        "pooled_lastfm_reach": pooled_reach,
        "missed_unique_count": len(missed),
        "missed_artists": [{"norm": n, "name": d} for n, d in sorted(missed.items())],
        "per_user": per_user_rows,
    }
    return out


# ── CEGE data-state discovery ──────────────────────────────────────────────────
def discover_cege_state(cege_root: pathlib.Path) -> dict:
    """Report the concrete data state of the CEGE repo so the verdict can name
    it. A populated graph would be a Postgres dump / sqlite / parquet under
    data/; only seed *.sql/*.csv stubs => the ETL has not run."""
    state = {"root": str(cege_root), "exists": cege_root.exists()}
    if not cege_root.exists():
        state["verdict"] = "CEGE repo not found on this machine"
        return state
    data_dir = cege_root / "data"
    files = []
    graph_like = []
    if data_dir.exists():
        for p in sorted(data_dir.rglob("*")):
            if p.is_file():
                rel = p.relative_to(data_dir).as_posix()
                files.append({"path": rel, "bytes": p.stat().st_size})
                if p.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".dump", ".parquet", ".duckdb"}:
                    graph_like.append(rel)
    state["data_dir_exists"] = data_dir.exists()
    state["data_files"] = files
    seed_only = bool(files) and all(
        f["path"].startswith("seed") or f["path"].endswith((".sql", ".csv"))
        for f in files
    )
    state["only_seed_stubs"] = seed_only and not graph_like
    state["graph_db_files"] = graph_like
    state["has_populated_graph"] = bool(graph_like)
    if graph_like:
        state["verdict"] = "populated graph artifacts present"
    elif seed_only:
        state["verdict"] = "seed SQL/CSV stubs only — MusicBrainz/Wikidata ETL has not run"
    elif not files:
        state["verdict"] = "data/ empty — ETL has not run"
    else:
        state["verdict"] = "no recognizable graph DB — treat as un-populated"
    return state


# ── MusicBrainz proxy ──────────────────────────────────────────────────────────
class MusicBrainz:
    def __init__(self):
        MB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self._last = 0.0
        self.requests_made = 0

    def _throttle(self):
        dt = time.monotonic() - self._last
        if dt < MB_MIN_INTERVAL:
            time.sleep(MB_MIN_INTERVAL - dt)
        self._last = time.monotonic()

    def _cache_path(self, key: str) -> pathlib.Path:
        safe = urllib.parse.quote(key, safe="")
        return MB_CACHE_DIR / f"{safe}.json"

    def _get(self, path: str, params: dict) -> dict:
        key = path + "?" + urllib.parse.urlencode(sorted(params.items()))
        cp = self._cache_path(key)
        if cp.exists():
            return json.loads(cp.read_text(encoding="utf-8"))
        self._throttle()
        url = f"{MB_BASE}/{path}?" + urllib.parse.urlencode({**params, "fmt": "json"})
        req = urllib.request.Request(url, headers={"User-Agent": MB_USER_AGENT})
        self.requests_made += 1
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                cp.write_text(json.dumps(data), encoding="utf-8")
                return data
            except urllib.error.HTTPError as e:
                if e.code == 503:  # MB rate-limit / busy — back off and retry
                    time.sleep(2.0 * (attempt + 1))
                    continue
                return {"error": e.code}
            except Exception as e:  # noqa: BLE001
                time.sleep(1.5 * (attempt + 1))
                if attempt == 3:
                    return {"error": str(e)}
        return {"error": "exhausted"}

    def probe(self, display_name: str, norm: str) -> dict:
        """Return presence + artist-relationship degree for one artist."""
        search = self._get("artist", {"query": f'artist:"{display_name}"', "limit": 5})
        artists = search.get("artists", []) if isinstance(search, dict) else []
        best = None
        for a in artists:
            if normalize_artist_name(a.get("name", "")) == norm:
                best = a
                break
        if best is None and artists:
            # accept a high-confidence top hit even if normalization differs
            top = artists[0]
            if int(top.get("score", 0)) >= 90:
                best = top
        present = best is not None
        degree = None
        mbid = None
        if present:
            mbid = best.get("id")
            look = self._get(f"artist/{mbid}", {"inc": "artist-rels"})
            rels = look.get("relations", []) if isinstance(look, dict) else []
            degree = len(rels)
        return {
            "norm": norm,
            "name": display_name,
            "present": present,
            "mbid": mbid,
            "match_score": int(best.get("score", 0)) if best else None,
            "artist_rel_degree": degree,
            "connected": bool(present and degree and degree > 0),
        }


# ── Phase B: run the proxy over a seeded sample and render the verdict ─────────
def run_proxy(missed: dict, sample_n: int, seed: int) -> dict:
    artists = missed["missed_artists"]
    rng = random.Random(seed)
    if sample_n and 0 < sample_n < len(artists):
        sample = rng.sample(artists, sample_n)
        sampling = f"random seeded sample n={sample_n} of {len(artists)} (seed={seed})"
    else:
        sample = list(artists)
        sampling = f"full set n={len(artists)}"

    mb = MusicBrainz()
    probes = []
    for i, a in enumerate(sample, 1):
        probes.append(mb.probe(a["name"], a["norm"]))
        if i % 10 == 0 or i == len(sample):
            print(f"    MB probe {i}/{len(sample)}  (requests={mb.requests_made})", flush=True)

    n = len(probes)
    present = sum(1 for p in probes if p["present"])
    connected = sum(1 for p in probes if p["connected"])
    present_rate = present / n if n else 0.0
    connected_rate = connected / n if n else 0.0

    lastfm_reach = missed["pooled_lastfm_reach"]
    # CEGE potential reach if it could route to the connected fraction of the
    # missed (eligible) set: reach_cege = reach_lastfm + connected_rate * (missed/eligible).
    # missed/eligible = 1 - reach_lastfm (the missed set IS eligible-in_pool).
    missed_frac_of_eligible = 1.0 - lastfm_reach
    cege_reach_connected = lastfm_reach + connected_rate * missed_frac_of_eligible
    cege_reach_present = lastfm_reach + present_rate * missed_frac_of_eligible

    ratio_connected = cege_reach_connected / lastfm_reach if lastfm_reach else float("inf")
    ratio_present = cege_reach_present / lastfm_reach if lastfm_reach else float("inf")

    verdict = "PROXY-PASS" if ratio_connected >= 2.0 else "PROXY-FAIL"

    return {
        "sampling": sampling,
        "sample_size": n,
        "mb_requests_made": mb.requests_made,
        "present": present,
        "connected": connected,
        "present_rate": present_rate,
        "connected_rate": connected_rate,
        "lastfm_pooled_reach": lastfm_reach,
        "missed_frac_of_eligible": missed_frac_of_eligible,
        "cege_reach_if_present": cege_reach_present,
        "cege_reach_if_connected": cege_reach_connected,
        "ratio_present_over_lastfm": ratio_present,
        "ratio_connected_over_lastfm": ratio_connected,
        "kill_criterion": "CEGE reach must be >= 2x Last.fm reach",
        "verdict": verdict,
        "probes": probes,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="T-B CEGE coverage spike")
    ap.add_argument("--artifact", default=str(DEFAULT_ARTIFACT))
    ap.add_argument("--cache", default=str(DEFAULT_CACHE),
                    help="path to the harness sqlite cache (default eval/.cache/lastfm.sqlite)")
    ap.add_argument("--cege-root", default=None,
                    help="CEGE repo root (default: sibling '../../cege' of the obscurity-engine repo, "
                         "else ~/cege)")
    ap.add_argument("--phase", choices=["a", "ab"], default="ab",
                    help="a = reconstruct missed set only; ab = + MusicBrainz proxy")
    ap.add_argument("--sample", type=int, default=200,
                    help="MB proxy sample size (0 = full set)")
    ap.add_argument("--seed", type=int, default=1729)
    args = ap.parse_args()

    cache_path = pathlib.Path(args.cache)
    if not cache_path.exists():
        raise SystemExit(f"cache not found: {cache_path} (run from the repo eval/ dir or pass --cache)")

    # CEGE data-state discovery
    if args.cege_root:
        cege_root = pathlib.Path(args.cege_root)
    else:
        # try repo-parent sibling, then ~/cege
        sibling = EVAL_DIR.parent.parent / "cege"
        home = pathlib.Path(os.path.expanduser("~")) / "cege"
        cege_root = sibling if sibling.exists() else home
    cege = discover_cege_state(cege_root)
    print("\n== CEGE data state ==")
    print(f"  root: {cege['root']}")
    print(f"  verdict: {cege.get('verdict')}")

    print("\n== Phase A: reconstruct adopted-but-not-in-pool set (cache-only) ==")
    missed = asyncio.run(reconstruct_missed_set(pathlib.Path(args.artifact), cache_path))
    missed["cege_state"] = cege
    (SPIKE_DIR / "missed_set.json").write_text(json.dumps(missed, indent=2), encoding="utf-8")
    print(f"  users reconstructed: {missed['users_reconstructed']}/{missed['users_in_artifact']} "
          f"(cache-incomplete: {missed['users_cache_incomplete']})")
    print(f"  cache hits/misses: {missed['cache_hits']}/{missed['cache_misses']}")
    print(f"  pooled eligible={missed['pooled_eligible']} in_pool={missed['pooled_in_pool']} "
          f"Last.fm reach={missed['pooled_lastfm_reach']:.4f}")
    print(f"  ADOPTED-BUT-NOT-IN-POOL unique artists: {missed['missed_unique_count']}")
    print(f"  wrote {SPIKE_DIR / 'missed_set.json'}")

    if args.phase == "a":
        return

    print("\n== Phase B: MusicBrainz proxy (presence + relationship degree) ==")
    proxy = run_proxy(missed, args.sample, args.seed)
    result = {"cege_state": cege, "phase_a": {k: v for k, v in missed.items()
                                              if k not in ("missed_artists", "per_user")},
              "proxy": {k: v for k, v in proxy.items() if k != "probes"},
              "probes": proxy["probes"]}
    (SPIKE_DIR / "mb_coverage.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"  sampling: {proxy['sampling']}")
    print(f"  present: {proxy['present']}/{proxy['sample_size']} ({proxy['present_rate']:.1%})")
    print(f"  connected(>=1 artist-rel): {proxy['connected']}/{proxy['sample_size']} "
          f"({proxy['connected_rate']:.1%})")
    print(f"  Last.fm reach={proxy['lastfm_pooled_reach']:.4f}  "
          f"CEGE reach(connected)={proxy['cege_reach_if_connected']:.4f}  "
          f"ratio={proxy['ratio_connected_over_lastfm']:.2f}x")
    print(f"  VERDICT: {proxy['verdict']} (kill criterion: >= 2x)")
    print(f"  wrote {SPIKE_DIR / 'mb_coverage.json'}")


if __name__ == "__main__":
    main()
