import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  putShare,
  getShare,
  validateSharePayload,
  __resetMemStore,
  SHARE_TTL_SECONDS,
  type SharePayload,
} from "./shareStore";

function makePayload(over: Partial<SharePayload> = {}): SharePayload {
  return {
    username: "alice",
    period: "blend",
    mode: "artists",
    appetite: "balanced",
    recommendations: [
      {
        name: "Duster",
        stickiness_score: 40,
        conviction_score: 120,
        composite_score: 60,
        total_listeners: 8000,
        top_tags: ["slowcore"],
        source_seeds: [{ name: "Bedhead", percentile: 12 }],
      },
    ],
    computedAt: 1_700_000_000_000,
    ...over,
  } as SharePayload;
}

beforeEach(() => {
  __resetMemStore();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetMemStore();
});

describe("shareStore roundtrip (in-memory fallback)", () => {
  it("stores a payload under a 10-char url-safe id and reads it back", async () => {
    const payload = makePayload();
    const id = await putShare(payload);
    expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(await getShare(id)).toEqual(payload);
  });

  it("returns distinct ids for successive shares", async () => {
    const a = await putShare(makePayload());
    const b = await putShare(makePayload());
    expect(a).not.toBe(b);
  });
});

describe("shareStore TTL expiry", () => {
  it("returns null once the entry is older than the 30-day TTL", async () => {
    const t0 = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const id = await putShare(makePayload());

    now.mockReturnValue(t0 + SHARE_TTL_SECONDS * 1000 - 1);
    expect(await getShare(id)).not.toBeNull();

    now.mockReturnValue(t0 + SHARE_TTL_SECONDS * 1000 + 1);
    expect(await getShare(id)).toBeNull();
  });
});

describe("shareStore oversized-payload rejection", () => {
  it("rejects a payload larger than the size cap", async () => {
    const huge = makePayload({
      recommendations: [
        {
          name: "x".repeat(200_000),
          stickiness_score: 1,
          conviction_score: 1,
          composite_score: 1,
          total_listeners: 1,
          top_tags: [],
          source_seeds: [],
        },
      ],
    });
    await expect(putShare(huge)).rejects.toThrow(RangeError);
  });
});

describe("shareStore unknown id", () => {
  it("returns null for an id that was never stored", async () => {
    expect(await getShare("doesnotexi")).toBeNull();
  });
});

describe("validateSharePayload", () => {
  it("accepts a well-formed payload", () => {
    expect(validateSharePayload(makePayload())).not.toBeNull();
  });

  it("rejects missing required fields", () => {
    const p = makePayload() as unknown as Record<string, unknown>;
    delete p.computedAt;
    expect(validateSharePayload(p)).toBeNull();
  });

  it("rejects wrong types", () => {
    expect(validateSharePayload(makePayload({ computedAt: "nope" as unknown as number }))).toBeNull();
    expect(validateSharePayload(makePayload({ recommendations: "nope" as unknown as [] }))).toBeNull();
  });

  it("rejects unknown extra keys", () => {
    const p = { ...makePayload(), evil: true };
    expect(validateSharePayload(p)).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(validateSharePayload(null)).toBeNull();
    expect(validateSharePayload("string")).toBeNull();
    expect(validateSharePayload([])).toBeNull();
  });
});
