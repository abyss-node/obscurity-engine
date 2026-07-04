import { describe, it, expect } from "vitest";
import { computeComparison, lowerMedian } from "./compare";
import type { Artist, DiscoveryData } from "./types";

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    name: "Artist",
    stickiness_score: 10,
    conviction_score: 10,
    composite_score: 10,
    total_listeners: 1000,
    top_tags: [],
    source_seeds: [],
    ...overrides,
  };
}

function discoveryData(artists: Artist[], extra: Partial<DiscoveryData> = {}): DiscoveryData {
  return { artists, top_genres: [], ...extra };
}

describe("computeComparison — overlap matching", () => {
  it("matches artists across sides case- and whitespace-insensitively", () => {
    const sharer = [makeArtist({ name: "  Duster " })];
    const visitor = discoveryData([makeArtist({ name: "duster" })]);
    const result = computeComparison(sharer, visitor);
    expect(result.overlap).toHaveLength(1);
    expect(result.overlap[0].name).toBe("  Duster ");
  });

  it("orders overlap by the sharer's composite_score descending", () => {
    const sharer = [
      makeArtist({ name: "Low Score", composite_score: 5 }),
      makeArtist({ name: "High Score", composite_score: 90 }),
      makeArtist({ name: "Mid Score", composite_score: 40 }),
    ];
    const visitor = discoveryData([
      makeArtist({ name: "low score" }),
      makeArtist({ name: "high score" }),
      makeArtist({ name: "mid score" }),
    ]);
    const result = computeComparison(sharer, visitor);
    expect(result.overlap.map((a) => a.name)).toEqual(["High Score", "Mid Score", "Low Score"]);
  });

  it("excludes artists present only on one side", () => {
    const sharer = [makeArtist({ name: "Only Sharer" }), makeArtist({ name: "Shared" })];
    const visitor = discoveryData([makeArtist({ name: "Shared" }), makeArtist({ name: "Only Visitor" })]);
    const result = computeComparison(sharer, visitor);
    expect(result.overlap.map((a) => a.name)).toEqual(["Shared"]);
  });
});

describe("computeComparison — weighted Jaccard taste match", () => {
  it("matches a hand-computed weighted-Jaccard fixture (no overlap boost)", () => {
    // Sharer profile: rock=1, jazz=1/2 (from one artist tagged [rock, jazz]).
    // Visitor profile: rock=1, pop=1/2 (from one artist tagged [rock, pop]).
    // Union: rock (min 1, max 1), jazz (min 0, max 0.5), pop (min 0, max 0.5).
    // Jaccard = 1 / (1 + 0.5 + 0.5) = 0.5 -> 50%. No name overlap, so no boost.
    const sharer = [makeArtist({ name: "SharerArtist", top_tags: ["rock", "jazz"] })];
    const visitor = discoveryData([makeArtist({ name: "VisitorArtist", top_tags: ["rock", "pop"] })]);
    const result = computeComparison(sharer, visitor);
    expect(result.overlap).toHaveLength(0);
    expect(result.tasteMatch).toBe(50);
  });

  it("returns 0 taste match for completely disjoint tag vocabularies", () => {
    const sharer = [makeArtist({ name: "A", top_tags: ["metal"] })];
    const visitor = discoveryData([makeArtist({ name: "B", top_tags: ["ambient"] })]);
    const result = computeComparison(sharer, visitor);
    expect(result.tasteMatch).toBe(0);
  });

  it("returns 100 taste match for identical single-artist tag profiles", () => {
    const sharer = [makeArtist({ name: "A", top_tags: ["metal", "doom"] })];
    const visitor = discoveryData([makeArtist({ name: "B", top_tags: ["metal", "doom"] })]);
    const result = computeComparison(sharer, visitor);
    expect(result.tasteMatch).toBe(100);
  });

  it("adds +10 per overlapping artist and clamps the total at 100", () => {
    // Identical tag profile (raw Jaccard = 100) plus 3 overlapping artists
    // (would be 100 + 30 = 130 uncapped) must clamp to exactly 100.
    const sharer = [
      makeArtist({ name: "One", top_tags: ["shoegaze"] }),
      makeArtist({ name: "Two", top_tags: ["shoegaze"] }),
      makeArtist({ name: "Three", top_tags: ["shoegaze"] }),
    ];
    const visitor = discoveryData([
      makeArtist({ name: "one", top_tags: ["shoegaze"] }),
      makeArtist({ name: "two", top_tags: ["shoegaze"] }),
      makeArtist({ name: "three", top_tags: ["shoegaze"] }),
    ]);
    const result = computeComparison(sharer, visitor);
    expect(result.overlap).toHaveLength(3);
    expect(result.tasteMatch).toBe(100);
  });

  it("the overlap boost alone (with zero raw tag similarity) can push the total past 100, and it clamps", () => {
    // Sharer and visitor tag vocabularies are completely disjoint (raw
    // weighted Jaccard = 0), so the entire pre-clamp score comes from the
    // +10-per-overlapping-artist boost: 11 overlapping artists -> a raw
    // (unclamped) total of 110, which must clamp down to exactly 100.
    const sharer = Array.from({ length: 11 }, (_, i) =>
      makeArtist({ name: `Artist${i}`, top_tags: [`sharer-tag-${i}`] })
    );
    const visitor = discoveryData(
      Array.from({ length: 11 }, (_, i) =>
        makeArtist({ name: `artist${i}`, top_tags: [`visitor-tag-${i}`] })
      )
    );
    const result = computeComparison(sharer, visitor);
    expect(result.overlap).toHaveLength(11);
    expect(result.tasteMatch).toBeLessThanOrEqual(100);
    expect(result.tasteMatch).toBe(100);
  });
});

describe("lowerMedian", () => {
  it("returns 0 for an empty array", () => {
    expect(lowerMedian([])).toBe(0);
  });

  it("returns the middle element for an odd-length array", () => {
    expect(lowerMedian([5, 1, 3])).toBe(3);
  });

  it("returns the lower-middle element (index n/2 - 1) for an even-length array, not an average", () => {
    // Sorted: [1, 2, 3, 4] -> n=4, lower-middle index = 4/2 - 1 = 1 -> value 2.
    expect(lowerMedian([4, 1, 3, 2])).toBe(2);
  });

  it("handles a single-element array", () => {
    expect(lowerMedian([42])).toBe(42);
  });
});

describe("computeComparison — median listener depth", () => {
  it("computes both sides' lower-median total_listeners", () => {
    const sharer = [
      makeArtist({ name: "A", total_listeners: 100 }),
      makeArtist({ name: "B", total_listeners: 300 }),
      makeArtist({ name: "C", total_listeners: 200 }),
    ];
    const visitor = discoveryData([
      makeArtist({ name: "D", total_listeners: 50 }),
      makeArtist({ name: "E", total_listeners: 10 }),
    ]);
    const result = computeComparison(sharer, visitor);
    expect(result.sharerMedianListeners).toBe(200); // odd -> true middle
    expect(result.visitorMedianListeners).toBe(10); // even -> lower middle
  });
});

describe("computeComparison — empty-input edge cases (no NaN anywhere)", () => {
  it("handles an empty sharer list", () => {
    const visitor = discoveryData([makeArtist({ name: "Solo", top_tags: ["indie"] })]);
    const result = computeComparison([], visitor);
    expect(result.overlap).toEqual([]);
    expect(result.tasteMatch).toBe(0);
    expect(result.sharerMedianListeners).toBe(0);
    expect(Number.isNaN(result.tasteMatch)).toBe(false);
    expect(Number.isNaN(result.sharerMedianListeners)).toBe(false);
    expect(Number.isNaN(result.visitorMedianListeners)).toBe(false);
  });

  it("handles an empty visitor artist list", () => {
    const sharer = [makeArtist({ name: "Solo", top_tags: ["indie"] })];
    const result = computeComparison(sharer, discoveryData([]));
    expect(result.overlap).toEqual([]);
    expect(result.tasteMatch).toBe(0);
    expect(result.visitorMedianListeners).toBe(0);
    expect(Number.isNaN(result.tasteMatch)).toBe(false);
  });

  it("handles both sides empty", () => {
    const result = computeComparison([], discoveryData([]));
    expect(result.overlap).toEqual([]);
    expect(result.tasteMatch).toBe(0);
    expect(result.sharerMedianListeners).toBe(0);
    expect(result.visitorMedianListeners).toBe(0);
    expect(Number.isNaN(result.tasteMatch)).toBe(false);
  });

  it("handles artists with empty top_tags arrays on both sides", () => {
    const sharer = [makeArtist({ name: "NoTags", top_tags: [] })];
    const visitor = discoveryData([makeArtist({ name: "AlsoNoTags", top_tags: [] })]);
    const result = computeComparison(sharer, visitor);
    expect(result.tasteMatch).toBe(0);
    expect(Number.isNaN(result.tasteMatch)).toBe(false);
  });
});
