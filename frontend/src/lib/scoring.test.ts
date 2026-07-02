import { describe, it, expect } from "vitest";
import {
  normConviction,
  normStickiness,
  compositeOf,
  obscurityDotSize,
  getDepthProse,
} from "./scoring";

// Fixtures pin the CURRENT scoring outputs so a future refactor can't silently
// shift any artist's displayed numbers. Values were computed by hand from the
// formulas in scoring.ts (see comments there).
const A = { conviction_score: 50, stickiness_score: 100, total_listeners: 5000 };
const B = { conviction_score: 200, stickiness_score: 10, total_listeners: 100 };
const C = { conviction_score: 1500, stickiness_score: 1000, total_listeners: 25000 };

describe("normConviction", () => {
  it("scales conviction/100 onto 0–100, capped at 10x", () => {
    expect(normConviction(A)).toBe(5);
    expect(normConviction(B)).toBe(20);
    expect(normConviction(C)).toBe(100); // min(15,10)*10
  });
});

describe("normStickiness", () => {
  it("log10-normalizes stickiness onto 0–100", () => {
    expect(normStickiness(A)).toBe(100); // log10(101)/log10(101) == 1
    expect(normStickiness(B)).toBe(52);
    expect(normStickiness(C)).toBe(100); // clamped at 10 before *10
  });
});

describe("compositeOf", () => {
  it("is round(conviction × stickiness / 10)", () => {
    expect(compositeOf(A)).toBe(50); // 5*100/10
    expect(compositeOf(B)).toBe(104); // 20*52/10
    expect(compositeOf(C)).toBe(1000); // 100*100/10
  });
});

describe("obscurityDotSize", () => {
  it("maps mainstream→small and deep-cut→large on a log listener scale", () => {
    expect(obscurityDotSize(25000)).toBeCloseTo(7, 5); // most mainstream
    expect(obscurityDotSize(100)).toBeCloseTo(21, 5); // deepest cut
    expect(obscurityDotSize(5000)).toBeCloseTo(11.0809, 3);
  });
  it("clamps out-of-range listener counts", () => {
    expect(obscurityDotSize(1_000_000)).toBeCloseTo(7, 5);
    expect(obscurityDotSize(0)).toBeCloseTo(21, 5); // 0 falls back to floor 100
  });
});

describe("getDepthProse", () => {
  it("returns the tier label for a score", () => {
    expect(getDepthProse(90)).toBe("collector-grade");
    expect(getDepthProse(72)).toBe("devoted listener");
    expect(getDepthProse(60)).toBe("adventurous");
    expect(getDepthProse(45)).toBe("eclectic");
    expect(getDepthProse(30)).toBe("wide listener");
  });
  it("appends a dominant genre when provided", () => {
    expect(getDepthProse(90, "shoegaze")).toBe("collector-grade, shoegaze focus");
  });
});
