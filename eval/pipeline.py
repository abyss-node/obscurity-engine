"""Python port of the discovery pipeline (backend/src/pipeline/*.rs).

This is the experimentation surface and the CEGE-portable home of the scoring
brain. With Config defaults it scores identically to the live Rust engine;
flip a Config lever to A/B an idea.

Notable faithful-but-simplified choices (documented so they're not silent):
  - Seeds are reconstructed from getRecentTracks counts, not gettopartists
    blend, so they're a true point-in-time snapshot. Weight = log2(count),
    matching the Rust single-period weighting.
  - Genre tags for both the cross-validation graph and the seed-tag profile
    come from artist.getinfo (Rust uses gettoptags for the profile). One fewer
    call per seed; same signal.
  - "Already knows" is the past-window set passed in, not live userplaycount,
    so the future never leaks into the input filter.
"""
from __future__ import annotations
import asyncio
import math
import statistics

from config import Config
from lastfm import LastfmClient


# ── obscurity threshold: "1000 true fans" model ───────────────────────────────
# A discovery target is an artist who is excellent but hasn't crossed the line
# where they can make a living — i.e. estimated true fans below a target T.
# True fans ≠ raw listeners: we convert via devotion (stickiness) relative to the
# artist's GENRE, and T tilts PER-USER by listening altitude. See config.py.

def _stickiness(info: dict) -> float:
    return info["playcount"] / info["listeners"] if info["listeners"] else 0.0


def _percentile(sorted_vals: list[float], pctl: float) -> float:
    """Linear-interpolated percentile on a pre-sorted list. pctl in [0,1]."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = pctl * (len(sorted_vals) - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return sorted_vals[lo]
    frac = idx - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def build_threshold(info_map: dict, seed_infos: list[dict], cfg: Config) -> dict:
    """Precompute genre-relative devotion refs (from the candidate pool) and the
    per-user sustainability target T (from seed-artist altitude).

    For the "discovery" model also compute a per-user backstop (the only hard
    exclusion) and a per-user obscurity appetite (the soft ranking tilt strength).
    """
    pool_sticks, genre_sticks = [], {}
    for info in info_map.values():
        s = _stickiness(info)
        if s <= 0:
            continue
        pool_sticks.append(s)
        if info["tags"]:
            genre_sticks.setdefault(info["tags"][0].lower(), []).append(s)
    pool_ref = statistics.median(pool_sticks) if pool_sticks else 1.0
    genre_ref = {
        g: statistics.median(v) for g, v in genre_sticks.items()
        if len(v) >= cfg.tf_min_genre_n
    }

    # per-user altitude tilt: where does this user's taste already sit?
    seed_listeners = [i["listeners"] for i in seed_infos if i["listeners"] > 0]
    user_med = statistics.median(seed_listeners) if seed_listeners else cfg.tf_global_ref_listeners
    factor = (user_med / cfg.tf_global_ref_listeners) ** cfg.tf_user_alpha
    factor = max(cfg.tf_user_clamp_lo, min(cfg.tf_user_clamp_hi, factor))

    th = {"genre_ref": genre_ref, "pool_ref": pool_ref or 1.0,
          "T_user": cfg.tf_target * factor, "user_median_listeners": user_med}

    # ── discovery model: per-user backstop + per-user obscurity appetite ──────
    if cfg.threshold_model == "discovery":
        seeds_sorted = sorted(seed_listeners)
        seed_pctl = _percentile(seeds_sorted, cfg.backstop_pctl)
        backstop = max(cfg.backstop_floor, seed_pctl * cfg.backstop_mult)
        if cfg.backstop_cap > 0:                     # absolute ceiling on the backstop
            backstop = min(backstop, cfg.backstop_cap)

        # appetite: fraction of seeds below the "obscure taste" reference, mapped
        # onto [appetite_min, appetite_max], shrunk toward the cohort prior.
        if cfg.personalize_appetite and seed_listeners:
            n = len(seed_listeners)
            frac_obscure = sum(1 for l in seed_listeners if l < cfg.bias_obscure_ref) / n
            raw = cfg.appetite_min + frac_obscure * (cfg.appetite_max - cfg.appetite_min)
            k = cfg.appetite_shrink_k
            appetite = (n * raw + k * cfg.global_appetite) / (n + k)
        else:
            appetite = cfg.global_appetite

        th["backstop"] = backstop
        th["appetite"] = appetite

    return th


def estimate_true_fans(info: dict, th: dict, cfg: Config) -> float:
    ref = (th["genre_ref"].get(info["tags"][0].lower()) if info["tags"] else None) or th["pool_ref"]
    conv = cfg.tf_base_conv * (_stickiness(info) / ref if ref else 1.0)
    conv = max(cfg.tf_conv_min, min(cfg.tf_conv_max, conv))
    return info["listeners"] * conv


def passes_threshold(info: dict, th: dict, cfg: Config) -> bool:
    if cfg.threshold_model == "flat":
        return info["listeners"] <= cfg.ceiling
    if cfg.threshold_model == "discovery":
        # the per-user backstop is the ONLY hard exclusion in discovery mode
        return info["listeners"] <= th["backstop"]
    if info["listeners"] > cfg.tf_listener_backstop:
        return False
    return estimate_true_fans(info, th, cfg) < th["T_user"]


def normalize_artist_name(name: str) -> str:
    """Port of utils.rs normalize_artist_name."""
    s = name.strip().lower().replace("&", "and")
    if s.startswith("the "):
        s = s[4:]
    s = "".join(c for c in s if c.isalnum() or c.isspace())
    return " ".join(s.split())


def collab_components(name: str) -> list[str]:
    lower = name.lower()
    for sep in (" & ", " feat. ", " ft. ", " x "):
        if sep in lower:
            return [p.strip() for p in name.split(sep)]
    return []


# ── stage 1: seeds (from reconstructed plays) ─────────────────────────────────

def build_seeds(plays: dict[str, list], cfg: Config):
    """plays: norm -> [display, count]. Returns (weights{display:w}, names[])."""
    items = sorted(plays.values(), key=lambda dc: dc[1], reverse=True)[: cfg.max_seeds]
    weights, names = {}, []
    for display, count in items:
        weights[display] = max(math.log2(max(count, 1)), 1.0)
        names.append(display)
    return weights, names


# ── stage 2: similar-artist candidates ────────────────────────────────────────

async def build_candidates(client: LastfmClient, names: list[str], cfg: Config) -> dict:
    """norm -> {"display": str, "recs": {seed_name: match}, "hop": 1|2}

    1-hop: similar artists of each seed (recommender = the seed).
    2-hop (cfg.two_hop): expand the most-corroborated 1-hop candidates one more
    hop. A 2-hop candidate inherits its intermediary's seeds, with match
    propagated multiplicatively (seed→inter m1 × inter→cand m2 × discount), so
    deeper paths carry proportionally less weight.
    """
    results = await asyncio.gather(
        *(client.similar(seed, cfg.similar_per_seed) for seed in names)
    )
    cmap: dict[str, dict] = {}
    for seed, sims in zip(names, results):
        for cand_name, match in sims:
            norm = normalize_artist_name(cand_name)
            entry = cmap.setdefault(norm, {"display": cand_name, "recs": {}, "hop": 1})
            entry["recs"][seed] = max(entry["recs"].get(seed, 0.0), match)

    if not cfg.two_hop:
        return cmap

    # expand the top 1-hop candidates by recommender count (most corroborated)
    expand = sorted(cmap.items(), key=lambda kv: len(kv[1]["recs"]), reverse=True)[: cfg.two_hop_expand]
    exp_results = await asyncio.gather(
        *(client.similar(inter["display"], cfg.similar_per_seed) for _n, inter in expand)
    )
    for (_inter_norm, inter), sims in zip(expand, exp_results):
        for cand_name, m2 in sims:
            norm = normalize_artist_name(cand_name)
            if norm in cmap and cmap[norm]["hop"] == 1:
                continue  # don't demote a genuine 1-hop candidate
            entry = cmap.setdefault(norm, {"display": cand_name, "recs": {}, "hop": 2})
            for seed, m1 in inter["recs"].items():
                propagated = m1 * m2 * cfg.two_hop_discount
                entry["recs"][seed] = max(entry["recs"].get(seed, 0.0), propagated)
    return cmap


# ── stage 1.5: tag graph + seed-tag profile ───────────────────────────────────

async def build_tag_signals(client: LastfmClient, weights: dict, names: list[str], cfg: Config):
    """Returns (cross_validation_set{norm}, seed_tag_profile{tag: weight})."""
    profile_seeds = names[: cfg.profile_top_seeds]
    infos = await asyncio.gather(*(client.artist_info(n) for n in profile_seeds))

    # seed-tag profile: weighted tag frequency, normalized so top tag = 1.0
    total = sum(weights[n] for n in profile_seeds) or 1.0
    profile: dict[str, float] = {}
    tag_freq: dict[str, int] = {}
    for name, info in zip(profile_seeds, infos):
        if not info:
            continue
        share = weights[name] / total
        for tag in info["tags"][: cfg.profile_tags_per_seed]:
            profile[tag.lower()] = profile.get(tag.lower(), 0.0) + share
        # cross-validation tag derivation uses the top seeds' top-3 tags
        if name in names[: cfg.top_seeds_for_tags]:
            for tag in info["tags"][:3]:
                tag_freq[tag.lower()] = tag_freq.get(tag.lower(), 0) + 1
    max_w = max(profile.values(), default=0.0)
    if max_w > 0:
        profile = {t: w / max_w for t, w in profile.items()}

    genre_tags = [t for t, _ in sorted(tag_freq.items(), key=lambda kv: kv[1], reverse=True)][: cfg.tags_to_derive]
    artist_lists = await asyncio.gather(
        *(client.tag_top_artists(t, cfg.tag_artists_limit) for t in genre_tags)
    )
    cross = {normalize_artist_name(a) for lst in artist_lists for a in lst}
    return cross, profile


# ── stage 3+4: info fetch + scoring ───────────────────────────────────────────

def _cap_candidates(cmap: dict, cfg: Config) -> list[str]:
    ranked = sorted(cmap.items(), key=lambda kv: len(kv[1]["recs"]), reverse=True)
    return [norm for norm, _ in ranked[: cfg.max_candidates]]


async def fetch_infos(client: LastfmClient, norms: list[str], cmap: dict) -> dict:
    displays = [cmap[n]["display"] for n in norms]
    infos = await asyncio.gather(*(client.artist_info(d) for d in displays))
    return {n: info for n, info in zip(norms, infos) if info}


def score(cmap, info_map, weights, cross, past_known, profile, cfg: Config, th: dict) -> list[dict]:
    listener_map = {n: info["listeners"] for n, info in info_map.items()}
    # collab-component ceiling: flat 25K live, but the per-user backstop in discovery
    comp_ceiling = th["backstop"] if cfg.threshold_model == "discovery" else cfg.ceiling
    items = []
    for norm, info in info_map.items():
        if norm in past_known:                       # already listens (past window)
            continue
        if not passes_threshold(info, th, cfg):       # past the sustainability line
            continue
        comps = collab_components(info["name"])       # collab component ceiling check
        if comps and any(
            listener_map.get(normalize_artist_name(c), 0) > comp_ceiling for c in comps
        ):
            continue

        cand = cmap.get(norm, {})
        conv = 0.0
        for seed, match in cand.get("recs", {}).items():
            w = weights.get(seed)
            if w is None:
                continue
            capped = min(w, cfg.conviction_cap)
            conv += capped * match if cfg.use_match_weight else capped
        if cand.get("hop", 1) == 2:
            conv *= cfg.two_hop_discount   # lower confidence for similar-of-similar
        is_cross = norm in cross
        if is_cross:
            conv += cfg.cross_validation_bonus

        conv_score = int(conv * 100)
        stickiness = info["playcount"] / info["listeners"] if info["listeners"] else 0.0
        items.append({
            "norm": norm,
            "name": info["name"],
            "listeners": info["listeners"],
            "conviction": conv_score,
            "stickiness": stickiness,
            "composite": conv_score * stickiness,
            "tags": info["tags"][:5],
            "cross_validated": is_cross,
        })

    # taste-alignment uplift
    for it in items:
        align = min(sum(profile.get(t.lower(), 0.0) for t in it["tags"]), 1.0)
        it["alignment"] = align
        it["composite"] *= 1.0 + cfg.alignment_uplift * align

    # ── discovery: obscurity bias (soft) + tier tagging on the eligible pool ──
    if cfg.threshold_model == "discovery" and items:
        # pos = percentile position by listener count within the eligible pool
        # (0.0 = most obscure, 1.0 = most popular). Ties share a rank fraction.
        order = sorted(range(len(items)), key=lambda i: items[i]["listeners"])
        denom = max(len(items) - 1, 1)
        for rank, i in enumerate(order):
            items[i]["pos"] = rank / denom
        appetite = th["appetite"]
        for it in items:
            it["composite"] *= 1.0 + appetite * (1.0 - it["pos"])
            it["tier"] = _tier(it["pos"], cfg)

    items.sort(key=lambda x: x["composite"], reverse=True)
    ranked = _enforce_diversity(items, profile, cfg)

    if cfg.threshold_model == "discovery" and cfg.tier_variety:
        ranked = _enforce_tier_variety(ranked, items, cfg)
    return ranked


def _enforce_diversity(items: list[dict], profile: dict, cfg: Config) -> list[dict]:
    counts: dict[str, int] = {}
    out = []
    for it in items:
        if it["tags"]:
            primary = max(it["tags"], key=lambda t: profile.get(t.lower(), 0.0)).lower()
        else:
            primary = "untagged"
        if counts.get(primary, 0) < cfg.diversity_slots:
            counts[primary] = counts.get(primary, 0) + 1
            out.append(it)
    return out


# ── discovery: tier variety ──────────────────────────────────────────────────

_TIER_NAMES = ("ABYSS", "DEEP", "EMERGING", "CUSP")


def _tier(pos: float, cfg: Config) -> str:
    c0, c1, c2 = cfg.tier_cuts
    if pos < c0:
        return "ABYSS"
    if pos < c1:
        return "DEEP"
    if pos < c2:
        return "EMERGING"
    return "CUSP"


def _enforce_tier_variety(ranked: list[dict], all_items: list[dict], cfg: Config) -> list[dict]:
    """Guarantee the top-K spans all obscurity tiers. After composite ranking +
    genre diversity, for each tier with zero representation in the top-K, promote
    that tier's best-scoring candidate (from the full eligible pool, not already
    in the top-K) by replacing the lowest-scoring artist from the most-represented
    tier. Deterministic: process tiers in fixed order, recompute counts each step.
    """
    k = cfg.k
    if len(ranked) < k:
        return ranked

    topk = ranked[:k]
    tail = ranked[k:]
    topk_norms = {it["norm"] for it in topk}

    # best candidate per tier from the full eligible pool (highest composite first)
    by_tier_pool: dict[str, list[dict]] = {t: [] for t in _TIER_NAMES}
    for it in sorted(all_items, key=lambda x: x["composite"], reverse=True):
        by_tier_pool[it.get("tier", "CUSP")].append(it)

    for tier in _TIER_NAMES:
        if not by_tier_pool[tier]:
            continue  # no candidates of this tier exist at all — can't represent it
        counts: dict[str, int] = {}
        for it in topk:
            counts[it["tier"]] = counts.get(it["tier"], 0) + 1
        if counts.get(tier, 0) > 0:
            continue  # already represented

        # promote this tier's best candidate not already in the top-K
        promote = next((c for c in by_tier_pool[tier] if c["norm"] not in topk_norms), None)
        if promote is None:
            continue

        # evict the lowest-scoring member of the most-represented tier
        most_tier = max(counts, key=lambda t: counts[t])
        evict_idx = max(
            (i for i, it in enumerate(topk) if it["tier"] == most_tier),
            key=lambda i: -topk[i]["composite"],  # lowest composite within that tier
        )
        evicted = topk[evict_idx]
        topk[evict_idx] = promote
        topk_norms.discard(evicted["norm"])
        topk_norms.add(promote["norm"])
        tail.insert(0, evicted)

    return topk + tail


# ── orchestrator for a single user ────────────────────────────────────────────

async def collect_plays(client: LastfmClient, user: str, from_ts: int, to_ts: int, cfg: Config) -> dict:
    """norm -> [display, count] over [from_ts, to_ts]."""
    plays: dict[str, list] = {}
    page = 1
    while True:
        data = await client.recent_tracks(user, from_ts, to_ts, page)
        rt = data.get("recenttracks", {})
        tracks = rt.get("track", [])
        if isinstance(tracks, dict):
            tracks = [tracks]
        for t in tracks:
            if t.get("@attr", {}).get("nowplaying") or "date" not in t:
                continue
            art = t.get("artist", {})
            name = art.get("#text") or art.get("name")
            if not name:
                continue
            norm = normalize_artist_name(name)
            entry = plays.setdefault(norm, [name, 0])
            entry[1] += 1
        total_pages = int(rt.get("@attr", {}).get("totalPages", "1") or 1)
        if page >= total_pages or page >= cfg.max_recent_pages:
            break
        page += 1
    return plays


async def run_user(client: LastfmClient, user: str, anchor: int, cfg: Config) -> dict | None:
    cutoff = anchor - cfg.future_days * 86400
    past_from = cutoff - cfg.past_days * 86400

    plays_before = await collect_plays(client, user, past_from, cutoff, cfg)
    if len(plays_before) < cfg.min_seeds:
        return {"user": user, "skipped": "thin past history", "n_seeds": len(plays_before)}

    plays_after = await collect_plays(client, user, cutoff, anchor, cfg)
    past_known = set(plays_before.keys())
    ground_truth = {
        norm for norm, (_d, count) in plays_after.items()
        if norm not in past_known and count >= cfg.min_future_plays
    }
    if not ground_truth:
        return {"user": user, "skipped": "no new adopted artists in holdout"}

    weights, names = build_seeds(plays_before, cfg)
    cmap = await build_candidates(client, names, cfg)
    cross, profile = await build_tag_signals(client, weights, names, cfg)
    cand_norms = _cap_candidates(cmap, cfg)
    info_map = await fetch_infos(client, cand_norms, cmap)

    # per-user, genre-relative, devotion-aware threshold (cached seed fetches)
    seed_infos = await asyncio.gather(*(client.artist_info(n) for n in names[: cfg.profile_top_seeds]))
    th = build_threshold(info_map, [i for i in seed_infos if i], cfg)

    ranked = score(cmap, info_map, weights, cross, past_known, profile, cfg, th)

    # reach funnel: adopted → eligible (passes threshold) → generated as candidate
    gt_infos = await asyncio.gather(
        *(client.artist_info(plays_after[n][0]) for n in ground_truth)
    )
    eligible = {
        n for n, info in zip(ground_truth, gt_infos)
        if info and passes_threshold(info, th, cfg)
    }
    in_pool = eligible & set(cmap.keys())

    return {
        "user": user,
        "ground_truth": ground_truth,
        "eligible": eligible,
        "in_pool": in_pool,
        "ranked": ranked,
        "n_seeds": len(names),
        "n_candidates": len(cmap),
        "T_user": round(th["T_user"]),
        "user_median_listeners": round(th["user_median_listeners"]),
    }
