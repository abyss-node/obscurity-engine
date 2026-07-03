"""ListenBrainz candidate-source client (T-C spike, eval harness only).

Adds a second candidate-generation path alongside Last.fm's artist.getsimilar:
labs.api.listenbrainz.org's similar-artists endpoint, which is MBID-keyed (not
name-keyed) and community-listening-session-based rather than tag/co-listen
based like Last.fm's. That makes it a structurally different candidate source
worth A/B'ing.

Two hosts are involved, each rate-limited independently to ~1 req/s with a
descriptive User-Agent (both labs.api.listenbrainz.org and musicbrainz.org ask
for this):

  1. labs.api.listenbrainz.org/similar-artists/json — the candidate source
     itself. Takes `artist_mbids` + a fixed `algorithm` enum, returns already
     name-attached neighbors (no reverse MBID->name lookup needed).
  2. musicbrainz.org/ws/2/artist — MBID resolution FALLBACK ONLY. Tier 1 is
     free: Last.fm's own artist.getinfo already returns an `mbid` field for
     most well-known artists, and that call is cached/shared with the rest of
     the pipeline (see `resolve_mbid`). MusicBrainz search is only hit when
     Last.fm has no mbid on file.

Resolution miss-rate (seed names that fail BOTH tiers, and so contribute zero
ListenBrainz candidates) is tracked on the client and surfaced in the harness
report — the spec calls it out as part of the answer, not an implementation
detail: a lot of the "does ListenBrainz beat Last.fm" verdict lives here.

Every network call on both hosts is sqlite-cached like the Last.fm client,
in eval/.cache/listenbrainz.sqlite (a separate file so a cold ListenBrainz run
never writes into the pre-warmed Last.fm cache).
"""
from __future__ import annotations
import asyncio
import json
import pathlib
import time
import urllib.parse

import aiohttp

from cache import Cache

ROOT = pathlib.Path(__file__).resolve().parent
LB_CACHE_PATH = ROOT / ".cache" / "listenbrainz.sqlite"

LB_SIMILAR_URL = "https://labs.api.listenbrainz.org/similar-artists/json"
MB_SEARCH_URL = "https://musicbrainz.org/ws/2/artist/"
# Fixed algorithm enum (labs API rejects anything else) — long window (7500
# sessions), moderate contribution/threshold floor, pre-filtered, limit 100.
LB_ALGORITHM = (
    "session_based_days_7500_session_300_contribution_5_threshold_10_"
    "limit_100_filter_True_skip_30"
)
USER_AGENT = (
    "obscurity-engine-eval-spike/0.1 "
    "( T-C ListenBrainz candidate-source A/B; contact: gauravg@deepnative.ai )"
)


class _RateLimiter:
    """Serializes calls to ~1 per `interval` seconds for one host.

    A lock-protected timestamp, not a token bucket: every caller awaits its
    turn, so concurrent asyncio.gather() callers still can't exceed the rate,
    regardless of how many users/seeds are in flight at once.
    """

    def __init__(self, interval: float = 1.05):
        self.interval = interval
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            delta = now - self._last
            if delta < self.interval:
                await asyncio.sleep(self.interval - delta)
            self._last = time.monotonic()


class ListenBrainzClient:
    def __init__(self, cache: Cache | None = None):
        self.cache = cache or Cache(LB_CACHE_PATH)
        self.session: aiohttp.ClientSession | None = None
        self._lb_limiter = _RateLimiter(1.05)
        self._mb_limiter = _RateLimiter(1.05)
        self._mbid_memo: dict[str, str | None] = {}  # in-process, avoids duplicate races
        self._mbid_locks: dict[str, asyncio.Lock] = {}
        # resolution diagnostics — the "miss-rate" the spec asks for
        self.stat_resolved_lastfm = 0
        self.stat_resolved_musicbrainz = 0
        self.stat_unresolved = 0
        self.stat_similar_calls = 0
        self.stat_similar_empty = 0

    async def start(self) -> None:
        if self.session is None:
            timeout = aiohttp.ClientTimeout(total=15, connect=5)
            self.session = aiohttp.ClientSession(
                timeout=timeout, headers={"User-Agent": USER_AGENT}
            )

    async def close(self) -> None:
        if self.session:
            await self.session.close()
            self.session = None

    # ── low-level cached GET (shared by both hosts, keyed by prefix) ──────────

    async def _get(self, url: str, params: dict, limiter: _RateLimiter, prefix: str):
        ck = prefix + ":" + urllib.parse.urlencode(dict(sorted(params.items())))
        cached = self.cache.get(ck)
        if cached is not None:
            try:
                return json.loads(cached)
            except ValueError:
                return None
        await limiter.wait()
        try:
            async with self.session.get(url, params=params) as resp:
                if resp.status != 200:
                    return None
                text = await resp.text()
                try:
                    data = json.loads(text)
                except ValueError:
                    return None
                self.cache.set(ck, text)
                return data
        except Exception:  # noqa: BLE001 - network resilience, mirrors lastfm.py
            return None

    # ── MBID resolution: Last.fm mbid field (free) -> MusicBrainz search ──────

    async def resolve_mbid(self, name: str, lastfm_client) -> str | None:
        """Resolve an artist display name to a MusicBrainz ID.

        Tier 1: Last.fm's artist.getinfo `mbid` field — reuses the Last.fm
        client's own cache/key-rotation, so this is free when that info was
        (or will be) fetched anyway, and still cheap (a single Last.fm call,
        not rate-limited beyond Last.fm's own pool) when it wasn't.
        Tier 2: MusicBrainz artist search, rate-limited ~1 req/s, cached.
        """
        if name in self._mbid_memo:
            return self._mbid_memo[name]
        lock = self._mbid_locks.setdefault(name, asyncio.Lock())
        async with lock:
            if name in self._mbid_memo:  # resolved while we waited for the lock
                return self._mbid_memo[name]
            mbid = await self._resolve_via_lastfm(name, lastfm_client)
            if mbid:
                self.stat_resolved_lastfm += 1
            else:
                mbid = await self._resolve_via_musicbrainz(name)
                if mbid:
                    self.stat_resolved_musicbrainz += 1
                else:
                    self.stat_unresolved += 1
            self._mbid_memo[name] = mbid
            return mbid

    async def _resolve_via_lastfm(self, name: str, lastfm_client) -> str | None:
        # Uses the Last.fm client's own cached _get — no new network policy,
        # no double-fetch: if the pipeline already needed this artist's info
        # for scoring, this is a pure cache read.
        data = await lastfm_client._get({"method": "artist.getinfo", "artist": name})
        artist = data.get("artist") if isinstance(data, dict) else None
        if not artist:
            return None
        mbid = artist.get("mbid")
        return mbid or None

    async def _resolve_via_musicbrainz(self, name: str) -> str | None:
        query = f'artist:"{name}"'
        data = await self._get(
            MB_SEARCH_URL,
            {"query": query, "fmt": "json", "limit": 3},
            self._mb_limiter,
            "mb:search",
        )
        if not data:
            return None
        artists = data.get("artists") or []
        if not artists:
            return None
        # highest-score result only; MB search is already relevance-ranked
        best = artists[0]
        if best.get("score", 0) < 80:  # weak match — don't attach the wrong artist
            return None
        return best.get("id")

    # ── similar-artists ─────────────────────────────────────────────────────

    async def similar(self, mbid: str, limit: int) -> list[tuple[str, float]]:
        data = await self._get(
            LB_SIMILAR_URL,
            {"artist_mbids": mbid, "algorithm": LB_ALGORITHM},
            self._lb_limiter,
            "lb:similar",
        )
        self.stat_similar_calls += 1
        if not isinstance(data, list) or not data:
            self.stat_similar_empty += 1
            return []
        # LB `score` is an unbounded raw count (community listening-session
        # co-occurrence), not a 0-1 match — normalize per-seed so it composes
        # with the rest of the pipeline's conviction math the same way
        # Last.fm's already-normalized `match` does.
        max_score = max((float(a.get("score", 0) or 0) for a in data), default=0.0) or 1.0
        out = []
        for a in sorted(data, key=lambda a: a.get("score", 0), reverse=True)[:limit]:
            name = a.get("name")
            if not name:
                continue
            match = float(a.get("score", 0) or 0) / max_score
            out.append((name, match))
        return out

    def resolution_stats(self) -> dict:
        total = (
            self.stat_resolved_lastfm
            + self.stat_resolved_musicbrainz
            + self.stat_unresolved
        )
        return {
            "resolved_via_lastfm": self.stat_resolved_lastfm,
            "resolved_via_musicbrainz": self.stat_resolved_musicbrainz,
            "unresolved": self.stat_unresolved,
            "total_resolution_attempts": total,
            "miss_rate": (self.stat_unresolved / total) if total else 0.0,
            "similar_calls": self.stat_similar_calls,
            "similar_empty": self.stat_similar_empty,
        }


# ── process-wide singleton ─────────────────────────────────────────────────
# Shared across every concurrent run_user() call in the harness process so the
# two host rate limiters are actually global (per-user instances would let N
# concurrent users each fire at ~1/s => N req/s in aggregate — not polite).

_singleton: ListenBrainzClient | None = None
_singleton_lock = asyncio.Lock()


async def get_client() -> ListenBrainzClient:
    global _singleton
    async with _singleton_lock:
        if _singleton is None:
            _singleton = ListenBrainzClient()
            await _singleton.start()
        return _singleton


async def close_client() -> None:
    global _singleton
    if _singleton is not None:
        await _singleton.close()
        _singleton = None


# ── candidate-map construction (same shape as pipeline.build_candidates) ───

async def build_candidates_lb(lastfm_client, names: list[str], cfg) -> dict:
    """norm -> {"display": str, "recs": {seed_name: match}, "hop": 1}

    Mirrors pipeline.build_candidates's output shape exactly so the rest of
    the pipeline (scoring, diversity, tier variety) is candidate-source
    agnostic. Seeds that fail MBID resolution simply contribute no candidates
    — that's the reach cost of the miss-rate, not a bug.
    """
    from pipeline import normalize_artist_name  # deferred: avoid import cycle

    client = await get_client()
    mbids = await asyncio.gather(*(client.resolve_mbid(n, lastfm_client) for n in names))
    pairs = [(seed, mbid) for seed, mbid in zip(names, mbids) if mbid]
    sims = await asyncio.gather(*(client.similar(mbid, cfg.similar_per_seed) for _s, mbid in pairs))

    cmap: dict[str, dict] = {}
    for (seed, _mbid), neighbors in zip(pairs, sims):
        for cand_name, match in neighbors:
            norm = normalize_artist_name(cand_name)
            entry = cmap.setdefault(norm, {"display": cand_name, "recs": {}, "hop": 1})
            entry["recs"][seed] = max(entry["recs"].get(seed, 0.0), match)
    return cmap


def merge_candidate_maps(lf_map: dict, lb_map: dict) -> dict:
    """Union two candidate maps (already keyed by normalized name), taking the
    max per-seed match when both sources recommend the same candidate off the
    same seed (mirrors the existing 1-hop/2-hop merge rule in pipeline.py)."""
    merged: dict[str, dict] = {norm: {"display": e["display"], "recs": dict(e["recs"]), "hop": e["hop"]}
                                for norm, e in lf_map.items()}
    for norm, entry in lb_map.items():
        target = merged.setdefault(norm, {"display": entry["display"], "recs": {}, "hop": entry["hop"]})
        for seed, match in entry["recs"].items():
            target["recs"][seed] = max(target["recs"].get(seed, 0.0), match)
    return merged
