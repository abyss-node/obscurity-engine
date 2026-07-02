import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadCache, saveCache } from "./cache";

const KEY_PREFIX = "obscurity_cache_";
const TTL_MS = 15 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("cache roundtrip", () => {
  it("returns the saved payload for the same key tuple", () => {
    const data = { artists: [{ name: "Duster" }], depth_score: 71 };
    saveCache("alice", "blend", "artists", "balanced", data);
    expect(loadCache("alice", "blend", "artists", "balanced")).toEqual(data);
  });

  it("misses when any part of the key tuple differs", () => {
    saveCache("alice", "blend", "artists", "balanced", { x: 1 });
    expect(loadCache("alice", "7day", "artists", "balanced")).toBeNull();
    expect(loadCache("bob", "blend", "artists", "balanced")).toBeNull();
  });
});

describe("cache TTL expiry", () => {
  it("returns null and evicts once the entry is older than the TTL", () => {
    const t0 = 1_000_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    saveCache("alice", "blend", "artists", "balanced", { x: 1 });
    // Within the window: still a hit.
    now.mockReturnValue(t0 + TTL_MS - 1);
    expect(loadCache("alice", "blend", "artists", "balanced")).toEqual({ x: 1 });
    // Past the window: miss, and the stale key is removed.
    now.mockReturnValue(t0 + TTL_MS + 1);
    expect(loadCache("alice", "blend", "artists", "balanced")).toBeNull();
    expect(localStorage.getItem(`${KEY_PREFIX}alice_blend_artists_balanced`)).toBeNull();
  });
});

describe("cache quota-full prune path", () => {
  it("prunes expired entries and retries when setItem hits the quota", () => {
    // Seed an expired entry that prune should reclaim.
    const staleKey = `${KEY_PREFIX}stale_overall_artists_new`;
    localStorage.setItem(
      staleKey,
      JSON.stringify({ data: { x: 0 }, ts: Date.now() - TTL_MS - 1000 }),
    );

    // First setItem throws a quota error; subsequent calls behave normally.
    const realSetItem = Storage.prototype.setItem;
    let firstWrite = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      if (firstWrite) {
        firstWrite = false;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      return realSetItem.call(this, k, v);
    });

    saveCache("bob", "blend", "artists", "balanced", { y: 2 });

    // The stale entry was pruned and the new entry landed on the retry.
    expect(localStorage.getItem(staleKey)).toBeNull();
    expect(loadCache("bob", "blend", "artists", "balanced")).toEqual({ y: 2 });
  });
});
