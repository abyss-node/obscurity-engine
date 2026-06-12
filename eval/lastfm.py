"""Async Last.fm client — Python mirror of backend/src/lastfm.rs.

Adds one method the Rust client doesn't have: getRecentTracks with from/to
timestamps, used to reconstruct a user's listening as-of a cutoff for the
temporal holdout. All GETs go through the cache and a concurrency semaphore.
"""
from __future__ import annotations
import asyncio
import json
import urllib.parse

import aiohttp

from cache import Cache
from config import API_KEY, API_URL


class LastfmClient:
    def __init__(self, cache: Cache, concurrency: int = 5):
        self.cache = cache
        self.sem = asyncio.Semaphore(concurrency)
        self.session: aiohttp.ClientSession | None = None

    async def __aenter__(self):
        timeout = aiohttp.ClientTimeout(total=15, connect=5)
        self.session = aiohttp.ClientSession(timeout=timeout)
        return self

    async def __aexit__(self, *exc):
        if self.session:
            await self.session.close()

    def _cache_key(self, params: dict) -> str:
        # api_key excluded so key rotation never busts the cache
        return urllib.parse.urlencode(dict(sorted(params.items())))

    def _url(self, params: dict) -> str:
        full = {**params, "api_key": API_KEY, "format": "json"}
        return API_URL + "?" + urllib.parse.urlencode(full)

    async def _get(self, params: dict) -> dict:
        ck = self._cache_key(params)
        cached = self.cache.get(ck)
        if cached is not None:
            return json.loads(cached)

        async with self.sem:
            last = {"error": "never attempted"}
            for attempt in range(3):
                if attempt:
                    await asyncio.sleep(0.5 * (2 ** (attempt - 1)))
                try:
                    async with self.session.get(self._url(params)) as resp:
                        if resp.status == 200:
                            text = await resp.text()
                            self.cache.set(ck, text)
                            return json.loads(text)
                        if 400 <= resp.status < 500:
                            return {"error": resp.status}
                        last = {"error": resp.status}
                except Exception as e:  # noqa: BLE001 - network resilience
                    last = {"error": str(e)}
            return last

    # ── methods ──────────────────────────────────────────────────────────────

    async def recent_tracks(self, user: str, from_ts: int, to_ts: int, page: int) -> dict:
        return await self._get({
            "method": "user.getrecenttracks",
            "user": user,
            "from": from_ts,
            "to": to_ts,
            "limit": 200,
            "page": page,
        })

    async def similar(self, artist: str, limit: int) -> list[tuple[str, float]]:
        data = await self._get({
            "method": "artist.getsimilar",
            "artist": artist,
            "limit": limit,
        })
        out = []
        for a in data.get("similarartists", {}).get("artist", []):
            try:
                match = float(a.get("match", 0) or 0)
            except (TypeError, ValueError):
                match = 0.0
            out.append((a["name"], match))
        return out

    async def artist_info(self, artist: str) -> dict | None:
        data = await self._get({"method": "artist.getinfo", "artist": artist})
        a = data.get("artist")
        if not a or "stats" not in a:
            return None
        try:
            listeners = int(a["stats"]["listeners"])
            playcount = int(a["stats"]["playcount"])
        except (KeyError, TypeError, ValueError):
            return None
        tags = [t["name"] for t in a.get("tags", {}).get("tag", [])]
        return {"name": a["name"], "listeners": listeners,
                "playcount": playcount, "tags": tags}

    async def user_info(self, user: str) -> dict | None:
        data = await self._get({"method": "user.getinfo", "user": user})
        u = data.get("user")
        if not u:
            return None
        try:
            return {
                "name": u["name"],
                "playcount": int(u.get("playcount", 0)),
                "registered": int(u.get("registered", {}).get("unixtime", 0)),
            }
        except (KeyError, TypeError, ValueError):
            return None

    async def user_friends(self, user: str, limit: int = 50) -> list[str]:
        data = await self._get({"method": "user.getfriends", "user": user, "limit": limit})
        friends = data.get("friends", {}).get("user", [])
        if isinstance(friends, dict):
            friends = [friends]
        return [f["name"] for f in friends if "name" in f]

    async def tag_top_artists(self, tag: str, limit: int) -> list[str]:
        data = await self._get({
            "method": "tag.gettopartists",
            "tag": tag,
            "limit": limit,
        })
        return [a["name"] for a in data.get("topartists", {}).get("artist", [])]
