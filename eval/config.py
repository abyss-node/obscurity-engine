"""Config for the offline eval harness.

Mirrors the constants in `backend/src/pipeline/*.rs` so the Python port scores
identically to the live Rust engine by default. Every knob here is an A/B lever:
flip one, re-run, watch the metrics move. That is the whole point of the harness.
"""
from __future__ import annotations
import os
import pathlib
from dataclasses import dataclass
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent
BACKEND_ENV = ROOT.parent / "backend" / ".env"
CACHE_PATH = ROOT / ".cache" / "lastfm.sqlite"
API_URL = "http://ws.audioscrobbler.com/2.0/"


def load_api_key() -> str:
    """Prefer the process env, fall back to backend/.env (the live key)."""
    key = os.environ.get("LASTFM_API_KEY")
    if key:
        return key
    if BACKEND_ENV.exists():
        for line in BACKEND_ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("LASTFM_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(
        "LASTFM_API_KEY not found. Set the env var or add it to backend/.env"
    )


API_KEY = load_api_key()


def anchor_ts(date_str: str = "2026-06-10") -> int:
    """Fixed 'now' so the future-window getRecentTracks calls stay cacheable
    across runs. Override on the CLI only if you want a different reference point."""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


@dataclass
class Config:
    # ── temporal split ──────────────────────────────────────────────────────
    past_days: int = 365          # seed window: [cutoff-past_days, cutoff]
    future_days: int = 180        # holdout window: [cutoff, anchor]
    min_future_plays: int = 3     # a "real" adoption, not a one-off sample
    min_seeds: int = 15           # skip users too thin to evaluate
    max_recent_pages: int = 40    # bound getRecentTracks pagination per window

    # ── pipeline shape (mirrors seeds.rs / candidates.rs / tag_graph.rs) ─────
    max_seeds: int = 60           # Rust ships 100; 60 keeps first-run cost sane
    similar_per_seed: int = 20    # candidates.rs SIMILAR_ARTISTS_PER_SEED
    max_candidates: int = 300     # scoring.rs MAX_CANDIDATES_FOR_INFO_FETCH (600 live)
    top_seeds_for_tags: int = 15  # tag_graph.rs TOP_SEEDS_FOR_TAGS
    tags_to_derive: int = 3       # tag_graph.rs TAGS_TO_DERIVE
    tags_per_seed_derive: int = 3 # how many of each seed's own tags feed the tally (was hardcoded 3)
    tag_artists_limit: int = 100  # tag_graph.rs TAG_ARTISTS_LIMIT
    profile_top_seeds: int = 40   # scoring.rs build_seed_tag_profile TOP_SEEDS
    profile_tags_per_seed: int = 5

    # ── scoring constants (scoring.rs) ───────────────────────────────────────
    ceiling: int = 25_000               # MAX_LISTENER_CEILING
    conviction_cap: float = 3.0         # CONVICTION_CAP
    cross_validation_bonus: float = 0.5  # CROSS_VALIDATION_BONUS
    diversity_slots: int = 3            # DIVERSITY_SLOTS_PER_GENRE
    alignment_uplift: float = 0.5       # composite *= 1 + uplift * alignment

    # ── EXPERIMENT LEVERS (off = faithful baseline) ──────────────────────────
    # cross-validation de-biasing: tag.getTopArtists is popularity-ranked, so the
    # deepest cuts (the whole point) rarely make a broad genre's top-N and never
    # get the dual-signal. Lever 3 adds a popularity-NEUTRAL path: a candidate is
    # also cross-validated if its OWN tags overlap the user's seed-genre profile,
    # independent of how famous it is. (Levers 1+2 = tags_per_seed_derive /
    # tags_to_derive / tag_artists_limit, swept via the existing knobs above.)
    xval_genre_overlap: bool = False     # lever 3: tag-overlap cross-validation
    xval_overlap_min_tags: int = 2       # need ≥ this many of the candidate's tags in the profile
    xval_overlap_min_weight: float = 0.15  # a profile tag must carry ≥ this normalized weight to count
    use_match_weight: bool = False  # backlog #1: weight conviction by getSimilar match
    genre_relative_ceiling: bool = False  # backlog #2: per-genre listener percentile ceiling
    genre_ceiling_pctl: float = 0.75   # backlog #2: per-genre listener percentile = the ceiling
    genre_ceiling_min_n: int = 5       # min pool artists in a genre to trust its percentile (else fall back to absolute ceiling)
    two_hop: bool = False           # backlog #3: similar-of-similar candidate expansion
    two_hop_expand: int = 60        # how many top 1-hop candidates to expand a 2nd hop
    two_hop_discount: float = 0.5   # conviction penalty for 2-hop-only candidates
    temporal_seed_weighting: bool = False  # backlog #4: blend all-time weight with recency
    recency_days: int = 30                 # recent sub-window inside the past window
    recency_boost: float = 1.0             # weight *= 1 + recency_boost * (recent_plays / total_plays)

    # ── threshold model: "flat" (legacy 25K) | "true_fans" (per-user, devotion-aware)
    # The "1000 true fans" model: a discovery target is an artist who hasn't yet
    # crossed the sustainability line — estimated true fans below a target T,
    # where true_fans = listeners × conversion(devotion), conversion is genre-
    # relative (stickiness vs the genre median), and T tilts per-user by listening
    # altitude. All params below are guesses to FIT against adoption data.
    threshold_model: str = "flat"
    tf_target: float = 1000.0          # sustainability line, in estimated true fans
    tf_base_conv: float = 0.03         # true-fan fraction at reference (genre-median) devotion
    tf_conv_min: float = 0.005         # clamp on conversion (broad/shallow audiences)
    tf_conv_max: float = 0.15          # clamp on conversion (cult devotion)
    tf_min_genre_n: int = 5            # min pool artists in a genre to trust its median
    tf_global_ref_listeners: float = 50_000.0  # reference user altitude (median seed listeners)
    tf_user_alpha: float = 0.5         # per-user tilt strength (0 = none, 1 = linear)
    tf_user_clamp_lo: float = 0.5      # gentle tilt: T moves within ±2× of the anchor
    tf_user_clamp_hi: float = 2.0
    tf_listener_backstop: int = 300_000  # nobody this big is a "discovery", any devotion

    # ── "discovery" model: soft per-user threshold + obscurity bias + tier variety
    # Goal = enjoyable discovery with wide variety, NOT a hard obscurity gate.
    # Backstop: exclude only artists as big as the user's own biggest (per-user).
    backstop_pctl: float = 0.9         # exclude artists above this pctl of user's seed listeners
    backstop_mult: float = 1.0
    backstop_floor: int = 30_000       # generous minimum even for very obscure users
    backstop_cap: int = 0              # absolute ceiling on the per-user backstop (0 = off)
    # Obscurity bias (soft ranking tilt): composite *= 1 + appetite*(1 - pos)
    bias_obscure_ref: float = 100_000  # a seed artist under this = "obscure taste" (drives appetite)
    appetite_min: float = 0.3          # obscurity bias for fully-mainstream taste
    appetite_max: float = 1.8          # obscurity bias for fully-obscure taste
    global_appetite: float = 1.0       # used when personalize_appetite is off
    # Depth-2: per-user appetite inferred from behavior, shrunk to the cohort prior
    personalize_appetite: bool = True  # A/B toggle: per-user (True) vs global (False)
    appetite_shrink_k: float = 20.0    # partial-pooling strength (thin users → prior)
    # Tier variety: guarantee the top-K spans the obscurity range
    tier_variety: bool = True
    tier_cuts: tuple = (0.1, 0.3, 0.6)  # pos cutoffs → ABYSS / DEEP / EMERGING / CUSP

    # ── novelty model: "strict" (exclude ALL past-known) | "underexplored" ──────
    # In "underexplored" mode, an artist the user played FEWER times than their
    # mean plays-per-artist (total past plays ÷ distinct past artists, × mult) is
    # "light" — heard in passing, never dug into — and becomes recommendable, and
    # re-engagement with it counts as a hit. "deep" artists (plays ≥ threshold)
    # stay excluded as before. "strict" reproduces the legacy past_known behavior.
    novelty_model: str = "strict"
    underexplored_mult: float = 1.0  # threshold = mean_plays_per_artist × mult

    # ── eval ──────────────────────────────────────────────────────────────────
    k: int = 20                   # evaluate top-K recommendations
    concurrency: int = 5          # parallel Last.fm requests
