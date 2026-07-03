// Shared discovery domain types + constants. Moved verbatim out of
// app/page.tsx during the page.tsx decomposition — app/page.tsx re-exports
// the subset of these that were previously part of its public surface
// (consumers keep importing from "../app/page" unchanged) while new code can
// import directly from here.

export type Artist = {
  name: string;
  stickiness_score: number;
  conviction_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { name: string; percentile: number }[];
  cross_validated?: boolean;
  taste_alignment?: number;
  velocity?: number;
  reengagement?: boolean;
  user_playcount?: number;
  // Resolved listen/find links (populated by the backend resolver; gated per-artist).
  spotify_url?: string;
  bandcamp_url?: string;
  this_is_url?: string;
  // Phase 1-B persistence contract: nullable capability-style id. Absent/null
  // means save/dismiss/events UI stays hidden for this item.
  rec_id?: string | null;
};

export type TrackItem = {
  name: string;
  artist: string;
  conviction_score: number;
  stickiness_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { track: string; artist: string; percentile: number }[];
  taste_alignment: number;
};

export type GenreWeight = {
  name: string;
  weight: number;
};

export type DiscoveryData = {
  artists: Artist[];
  top_genres: GenreWeight[];
  deepest_date?: string;
  active_seed_count?: number;
  depth_score?: number;
  message?: string;
  // Phase 1-B persistence contract (nullable, additive): null/false with no
  // DB configured — every save/dismiss/events affordance stays hidden then.
  run_id?: string | null;
  persistence?: boolean;
};

export type TrackDiscoveryData = {
  tracks: TrackItem[];
  top_genres: GenreWeight[];
  active_seed_count: number;
  depth_score: number;
  message?: string;
};

export type SortType = "composite" | "conviction" | "stickiness" | "listeners";
export type DiscoveryMode = "artists" | "tracks";

export const PERIOD_LABELS: Record<string, string> = {
  blend: "MIX",
  "7day": "7D",
  "1month": "1M",
  "3month": "3M",
  "6month": "6M",
  "12month": "1Y",
  overall: "ALL",
};

// Discovery-appetite slider stops: how much re-engagement (resurfacing obscure
// artists you've only lightly played) to mix into pure discovery. Maps to the
// backend's underexplored-novelty multiplier. Ordered new → rediscover.
export const APPETITE_STOPS: { val: string; label: string; blurb: string }[] = [
  { val: "new", label: "Only new", blurb: "Brand-new artists only" },
  { val: "low", label: "Mostly new", blurb: "Mostly new, a few rediscoveries" },
  { val: "balanced", label: "Balanced", blurb: "Even mix of new and rediscovered gems" },
  { val: "high", label: "Rediscover", blurb: "Resurface obscure gems you've barely played" },
];

// Human-readable window phrase for the short-window empty state.
export const PERIOD_WINDOWS: Record<string, string> = {
  blend: "your library",
  "7day": "7-day window",
  "1month": "1-month window",
  "3month": "3-month window",
  "6month": "6-month window",
  "12month": "1-year window",
  overall: "all-time",
};
