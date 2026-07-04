/**
 * Pure label-collision resolution for the Discovery Matrix's always-on
 * (dual-signal) labels. No DOM, no randomness — same input always yields
 * the same output, so this is fully unit-testable outside of jsdom/layout.
 *
 * The matrix plots dots in a 0-100 percentage space (see `Dot.x`/`Dot.y` in
 * DiscoveryMatrix.tsx). Labels hang off a dot's edge, extending either left
 * or right (`anchorRight` mirrors `Dot.labelRight`), starting `dotOffsetPx`
 * away from the dot center (mirrors `offset = d.size / 2 + 7`). At narrow
 * viewports the purely-vertical `labelDy` stacking isn't enough to prevent
 * overlap, so this resolves collisions in real pixel space instead.
 */

/** Approximate width of one monospace glyph at the label's 9.5px font-size. */
const CHAR_WIDTH_PX = 5.7;
/** Fixed line height (+ a little breathing room) for a single-line label. */
const LABEL_HEIGHT_PX = 12;

export type LabelInput = {
  name: string;
  /** Dot center, 0-100 plot-percentage space (matches Dot.x). */
  xPct: number;
  /** Dot center, 0-100 plot-percentage space (matches Dot.y). */
  yPct: number;
  /** Lower = higher priority (e.g. array index in a pre-sorted, best-first list). */
  rank: number;
  /** Which side of the dot the label text extends toward (mirrors Dot.labelRight). */
  anchorRight: boolean;
  /** Distance in px from the dot center to where the label text begins. */
  dotOffsetPx: number;
};

export type LabelBox = {
  name: string;
  rank: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function estimateLabelWidthPx(name: string): number {
  return Math.max(1, name.length) * CHAR_WIDTH_PX;
}

/**
 * Converts a label input into its axis-aligned bounding box in real pixels,
 * given the plot container's measured dimensions. Vertically centered on
 * the dot (matching the `translateY(-50%)` the component applies today).
 */
export function computeLabelBox(
  label: LabelInput,
  containerWidthPx: number,
  containerHeightPx: number
): LabelBox {
  const cx = (label.xPct / 100) * containerWidthPx;
  const cy = (label.yPct / 100) * containerHeightPx;
  const width = estimateLabelWidthPx(label.name);

  let left: number;
  let right: number;
  if (label.anchorRight) {
    left = cx + label.dotOffsetPx;
    right = left + width;
  } else {
    right = cx - label.dotOffsetPx;
    left = right - width;
  }

  const top = cy - LABEL_HEIGHT_PX / 2;
  const bottom = cy + LABEL_HEIGHT_PX / 2;

  return { name: label.name, rank: label.rank, left, right, top, bottom };
}

/** Axis-aligned bounding box overlap test (touching edges do not count as overlap). */
export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Greedily resolves label collisions: sorts by rank (ties broken by name for
 * determinism), then keeps a label visible iff it doesn't overlap any
 * already-kept (i.e. strictly higher-priority) label. Returns a map of
 * label name -> whether it should be shown.
 */
export function resolveLabelCollisions(
  labels: LabelInput[],
  containerWidthPx: number,
  containerHeightPx: number
): Record<string, boolean> {
  const ordered = [...labels].sort(
    (a, b) => a.rank - b.rank || a.name.localeCompare(b.name)
  );

  const kept: LabelBox[] = [];
  const visible: Record<string, boolean> = {};

  for (const label of ordered) {
    const box = computeLabelBox(label, containerWidthPx, containerHeightPx);
    const collides = kept.some((k) => boxesOverlap(box, k));
    visible[label.name] = !collides;
    if (!collides) {
      kept.push(box);
    }
  }

  return visible;
}
