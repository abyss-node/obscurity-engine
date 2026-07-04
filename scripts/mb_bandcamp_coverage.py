"""MusicBrainz Bandcamp-URL coverage probe.

Follow-up to docs/spike-bandcamp-2026-07-04.md (Q4/"What I could not
establish"): the spike's own live MB query returned a non-credible
count:0 and was explicitly flagged as unresolved rather than reported.
This script answers the question properly: of a sample of artists this
product actually recommends, what fraction (a) resolve to a MusicBrainz
MBID at all, and (b) have a Bandcamp artist-URL relationship once
resolved? The answer gates whether the "Support on Bandcamp" link
(frontend/src/components/ArtistCard.tsx) is worth upgrading from a
plain bandcamp.com search link to an MB-precise artist URL.

Sample provenance: committed eval/*.json artifacts (e.g. eval/blend_n348.json)
were inspected first, per the task brief, but every committed result file
only stores aggregated per-user metrics (hits/reach/precision/etc.) — none
of them retain the actual recommended artist names (those live only in
eval/.cache/, which is gitignored and not committed). So this script falls
back to a hardcoded sample instead, as the task brief allows. The 40 names
below are hand-picked to span obscure-DIY to well-known-indie and to skew
toward the genres the spike's Q3 flagged as Bandcamp-adjacency-strong
(ambient, shoegaze, post-rock, experimental electronic, ffnoise/DIY
bedroom pop) — i.e. a reasonable proxy for "what this product's candidate
pool looks like," not a random sample.

Method (mirrors backend/src/listenbrainz.rs's MB politeness pattern exactly):
  1. MusicBrainz artist search (`GET /ws/2/artist/?query=artist:"<name>"`),
     accept only score >= 80 (MB_SCORE_FLOOR in listenbrainz.rs).
  2. For each resolved MBID, `GET /ws/2/artist/{mbid}?inc=url-rels&fmt=json`
     and count relations whose target-url resource contains "bandcamp.com".
  3. 1.1s pacing between MB calls (matches MB_MIN_INTERVAL = 1050ms in
     listenbrainz.rs — MB's own "~1 req/s" politeness ask), one call at a
     time (no concurrency), descriptive User-Agent (MB requires one).

Read-only against the public MusicBrainz web service. Does not touch
eval/**, does not call Bandcamp, no scraping.

Usage:
    python scripts/mb_bandcamp_coverage.py
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

MB_SEARCH_URL = "https://musicbrainz.org/ws/2/artist/"
MB_LOOKUP_URL = "https://musicbrainz.org/ws/2/artist/{mbid}"
MB_MIN_INTERVAL_S = 1.1
MB_SCORE_FLOOR = 80

# Same contact-identifying UA pattern as backend/src/listenbrainz.rs's
# USER_AGENT constant (MB requires a descriptive, contactable UA).
USER_AGENT = (
    "obscurity-engine-research/1.0 "
    "( Bandcamp coverage probe, one-off; contact: gauravg@deepnative.ai )"
)

# Hardcoded diverse sample (see module docstring for why). Ordered
# roughly known -> obscure within each genre cluster.
SAMPLE_ARTISTS: list[str] = [
    # well-known indie / slowcore / dream-pop
    "Duster", "Alex G", "Slowdive", "Beach House", "Mount Eerie",
    "Have a Nice Life", "Grouper", "Boris", "Tycho", "Julie",
    # mid-tier indie / DIY
    "Elvis Depressedly", "Squirrel Flower", "Foxing", "TOPS",
    "Runnner", "Wednesday", "Wisp", "Told Slant", "Ricky Eat Acid",
    "Rozwell Kid",
    # ambient / experimental electronic (spike Q3: strong Bandcamp adjacency)
    "Celer", "Rafael Anton Irisarri", "Green-House", "Hakobune",
    "Motion Sickness of Time Travel",
    # post-rock / shoegaze
    "Nothing", "Deafheaven", "Wild Pink", "Loose Tooth", "Have Mercy",
    # obscure / DIY bedroom-pop, deep long tail
    "Weatherday", "Parannoul", "Water From Your Eyes", "Nostalgist",
    "Michael Cera Palin", "Bedroom Eyes", "Ogbert the Nerd", "sadwrist",
    "For Elissa", "Emperor X",
]


@dataclass
class ProbeResult:
    name: str
    mbid: str | None = None
    score: int | None = None
    has_bandcamp: bool = False
    error: str | None = None


def _mb_get(url: str, params: dict[str, str]) -> dict:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{qs}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def mb_search(name: str) -> tuple[str | None, int | None]:
    """Same query shape/threshold as listenbrainz.rs::mb_search."""
    data = _mb_get(MB_SEARCH_URL, {"query": f'artist:"{name}"', "fmt": "json", "limit": "3"})
    artists = data.get("artists") or []
    if not artists:
        return None, None
    best = artists[0]
    score = int(best.get("score", 0))
    if score < MB_SCORE_FLOOR:
        return None, score
    return best.get("id"), score


def mb_has_bandcamp_url(mbid: str) -> bool:
    data = _mb_get(MB_LOOKUP_URL.format(mbid=mbid), {"inc": "url-rels", "fmt": "json"})
    for rel in data.get("relations") or []:
        url = (rel.get("url") or {}).get("resource", "")
        if "bandcamp.com" in url:
            return True
    return False


def run(sample: list[str]) -> list[ProbeResult]:
    results: list[ProbeResult] = []
    for i, name in enumerate(sample):
        r = ProbeResult(name=name)
        try:
            time.sleep(MB_MIN_INTERVAL_S)  # pace before every MB call, including the first
            mbid, score = mb_search(name)
            r.score = score
            if mbid:
                r.mbid = mbid
                time.sleep(MB_MIN_INTERVAL_S)
                r.has_bandcamp = mb_has_bandcamp_url(mbid)
        except urllib.error.URLError as e:
            r.error = str(e)
        except Exception as e:  # defensive: one bad response shouldn't kill the run
            r.error = f"{type(e).__name__}: {e}"
        results.append(r)
        status = "ERROR" if r.error else ("no-mbid" if not r.mbid else ("bandcamp" if r.has_bandcamp else "no-bandcamp"))
        print(f"[{i + 1}/{len(sample)}] {name!r:35s} -> {status}", file=sys.stderr)
    return results


def summarize(results: list[ProbeResult]) -> dict:
    n = len(results)
    resolved = [r for r in results if r.mbid]
    with_bandcamp = [r for r in resolved if r.has_bandcamp]
    errors = [r for r in results if r.error]
    return {
        "n_sampled": n,
        "n_resolved": len(resolved),
        "resolution_rate": round(len(resolved) / n, 3) if n else 0.0,
        "n_with_bandcamp_among_resolved": len(with_bandcamp),
        "bandcamp_rate_among_resolved": round(len(with_bandcamp) / len(resolved), 3) if resolved else 0.0,
        "n_errors": len(errors),
        "unresolved": [r.name for r in results if not r.mbid and not r.error],
        "with_bandcamp": [r.name for r in with_bandcamp],
    }


if __name__ == "__main__":
    print(f"Probing {len(SAMPLE_ARTISTS)} artists against MusicBrainz "
          f"(~{len(SAMPLE_ARTISTS) * 2 * MB_MIN_INTERVAL_S:.0f}s at {MB_MIN_INTERVAL_S}s/call, up to 2 calls/artist)...",
          file=sys.stderr)
    results = run(SAMPLE_ARTISTS)
    summary = summarize(results)
    print(json.dumps(summary, indent=2))
