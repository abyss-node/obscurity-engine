import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  computeLabelBox,
  resolveLabelCollisions,
  type LabelInput,
} from "./labelLayout";

/** Recomputes boxes for whatever the resolver marked visible and asserts
 *  none of them pairwise-overlap — a generic (not fixed-names) invariant
 *  check, per the spec. */
function assertNoVisibleOverlaps(
  labels: LabelInput[],
  visible: Record<string, boolean>,
  containerWidthPx: number,
  containerHeightPx: number
) {
  const shown = labels.filter((l) => visible[l.name]);
  const boxes = shown.map((l) => computeLabelBox(l, containerWidthPx, containerHeightPx));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(boxesOverlap(boxes[i], boxes[j])).toBe(false);
    }
  }
}

// A dense synthetic cluster: 8 labels crammed into a tight y-band (close
// xPct/yPct), alternating anchor sides, ranked 0..7 (0 = highest priority).
function denseCluster(): LabelInput[] {
  return Array.from({ length: 8 }, (_, i) => ({
    name: `Artist Longname ${i}`,
    xPct: 45 + i * 1.5,
    yPct: 48 + (i % 3), // tight vertical band
    rank: i,
    anchorRight: i % 2 === 0,
    dotOffsetPx: 10,
  }));
}

describe("labelLayout — resolveLabelCollisions", () => {
  it("hides some labels in a dense cluster at a narrow container width, and none of the kept ones overlap", () => {
    const labels = denseCluster();
    const narrowWidth = 330; // ~390px viewport minus padding/y-axis column
    const height = 400;

    const visible = resolveLabelCollisions(labels, narrowWidth, height);

    const visibleCount = Object.values(visible).filter(Boolean).length;
    expect(visibleCount).toBeLessThan(labels.length);
    expect(visibleCount).toBeGreaterThan(0);

    assertNoVisibleOverlaps(labels, visible, narrowWidth, height);
  });

  it("shows most/all labels at a wide container width where collisions mostly disappear", () => {
    const labels = denseCluster();
    const wideWidth = 1200;
    const height = 520;

    const visible = resolveLabelCollisions(labels, wideWidth, height);

    const visibleCount = Object.values(visible).filter(Boolean).length;
    // Not asserting every single label survives (they're still vertically
    // close), but the wide layout must retain strictly more than the narrow one.
    const narrowVisible = resolveLabelCollisions(labels, 330, height);
    const narrowCount = Object.values(narrowVisible).filter(Boolean).length;
    expect(visibleCount).toBeGreaterThan(narrowCount);

    assertNoVisibleOverlaps(labels, visible, wideWidth, height);
  });

  it("is deterministic: identical input produces identical output across repeated calls", () => {
    const labels = denseCluster();
    const width = 330;
    const height = 400;

    const first = resolveLabelCollisions(labels, width, height);
    const second = resolveLabelCollisions([...labels], width, height);

    expect(second).toEqual(first);
  });

  it("a strictly higher-priority (lower rank) label always wins a head-to-head overlap, regardless of input array order", () => {
    const high: LabelInput = {
      name: "AAA High Priority",
      xPct: 50,
      yPct: 50,
      rank: 0,
      anchorRight: true,
      dotOffsetPx: 10,
    };
    const low: LabelInput = {
      name: "ZZZ Low Priority",
      xPct: 50.5, // deliberately overlapping with `high`
      yPct: 50,
      rank: 1,
      anchorRight: true,
      dotOffsetPx: 10,
    };

    const width = 330;
    const height = 400;

    // Sanity: these two boxes really do overlap at this width, otherwise the
    // test doesn't exercise the priority rule at all.
    const boxHigh = computeLabelBox(high, width, height);
    const boxLow = computeLabelBox(low, width, height);
    expect(boxesOverlap(boxHigh, boxLow)).toBe(true);

    const inOrder = resolveLabelCollisions([high, low], width, height);
    const reversed = resolveLabelCollisions([low, high], width, height);

    expect(inOrder[high.name]).toBe(true);
    expect(inOrder[low.name]).toBe(false);
    expect(reversed[high.name]).toBe(true);
    expect(reversed[low.name]).toBe(false);
  });

  it("does not collide non-overlapping labels spread far apart", () => {
    const labels: LabelInput[] = [
      { name: "Far Left", xPct: 5, yPct: 10, rank: 0, anchorRight: true, dotOffsetPx: 10 },
      { name: "Far Right", xPct: 95, yPct: 90, rank: 1, anchorRight: false, dotOffsetPx: 10 },
    ];
    const visible = resolveLabelCollisions(labels, 1000, 500);
    expect(visible["Far Left"]).toBe(true);
    expect(visible["Far Right"]).toBe(true);
  });
});
