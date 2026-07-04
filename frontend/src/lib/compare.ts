import type { Artist, DiscoveryData } from "./types";

/**
 * Pure "compare with a friend" computation — no React, no fetch. Takes the
 * sharer's persisted recommendations (the `Artist[]` stored on a `/r/[id]`
 * share payload) and the visitor's own freshly-run `DiscoveryData`, and
 * derives a lightweight taste-match readout. Deliberately only touches
 * fields both sides reliably have (`name`, `composite_score`, `top_tags`,
 * `total_listeners`) — the stored share payload has no `depth_score`/
 * `top_genres`, so this can't lean on those.
 */

export interface ComparisonResult {
  /** Artists present on both sides, matched by trimmed/lowercased name,
   *  ordered by the sharer's composite_score descending. */
  overlap: Artist[];
  /** Integer 0-100: weighted-Jaccard genre similarity + an overlap boost, capped at 100. */
  tasteMatch: number;
  /** Lower-median total_listeners across the sharer's artist list (0 if empty). */
  sharerMedianListeners: number;
  /** Lower-median total_listeners across the visitor's artist list (0 if empty). */
  visitorMedianListeners: number;
}

const normalizeName = (name: string) => name.trim().toLowerCase();

/** Deterministic "lower middle" median — for an even-length sorted array of
 *  length n=2k this takes index k-1 (not the average of the two middle
 *  values), so the result is always one of the actual input values and
 *  exactly reproducible. Returns 0 for an empty array. */
export function lowerMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid];
}

/** Weighted genre profile: 1/rank per tag (1st tag=1, 2nd=1/2, ...),
 *  accumulated across every artist on that side, tags lowercased. */
function genreProfile(artists: Artist[]): Map<string, number> {
  const profile = new Map<string, number>();
  for (const artist of artists) {
    artist.top_tags.forEach((tag, i) => {
      const key = tag.trim().toLowerCase();
      if (!key) return;
      const weight = 1 / (i + 1);
      profile.set(key, (profile.get(key) ?? 0) + weight);
    });
  }
  return profile;
}

function weightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  // Array.from (not a `for...of`/spread over the Map/Set iterators directly)
  // — this repo's tsconfig target doesn't have downlevelIteration enabled,
  // so iterating Map/Set iterators directly is a tsc error there.
  const keys = new Set([...Array.from(a.keys()), ...Array.from(b.keys())]);
  let minSum = 0;
  let maxSum = 0;
  Array.from(keys).forEach((key) => {
    const wa = a.get(key) ?? 0;
    const wb = b.get(key) ?? 0;
    minSum += Math.min(wa, wb);
    maxSum += Math.max(wa, wb);
  });
  if (maxSum === 0) return 0;
  return minSum / maxSum;
}

/** Compute the sharer/visitor comparison used by the compare-section UI. */
export function computeComparison(
  sharerArtists: Artist[],
  visitorData: DiscoveryData
): ComparisonResult {
  const visitorArtists = visitorData.artists ?? [];

  const visitorNames = new Set(visitorArtists.map((a) => normalizeName(a.name)));

  const overlap = sharerArtists
    .filter((a) => visitorNames.has(normalizeName(a.name)))
    .sort((a, b) => b.composite_score - a.composite_score);

  const sharerProfile = genreProfile(sharerArtists);
  const visitorProfile = genreProfile(visitorArtists);
  const rawSimilarity = weightedJaccard(sharerProfile, visitorProfile) * 100;
  const boosted = rawSimilarity + overlap.length * 10;
  const tasteMatch = Math.round(Math.min(100, Math.max(0, boosted)));

  const sharerMedianListeners = lowerMedian(sharerArtists.map((a) => a.total_listeners));
  const visitorMedianListeners = lowerMedian(visitorArtists.map((a) => a.total_listeners));

  return { overlap, tasteMatch, sharerMedianListeners, visitorMedianListeners };
}
