import type { Artist } from "../app/page";

/**
 * Shared score normalizers — keep the Discovery Matrix, the ledger, and any
 * card view in perfect agreement. Both return an integer on a 0–100 scale.
 *
 * These formulas are lifted verbatim from the original ArtistCard so the
 * redesign doesn't silently shift any artist's displayed numbers.
 */
export function normConviction(a: Pick<Artist, "conviction_score">): number {
  return Math.round(Math.min(a.conviction_score / 100, 10) * 10);
}

export function normStickiness(a: Pick<Artist, "stickiness_score">): number {
  return Math.round(
    Math.min((Math.log10(a.stickiness_score + 1) / Math.log10(101)) * 10, 10) * 10
  );
}

/** Default-sort composite, per the redesign spec: round(conviction × stickiness / 10). */
export function compositeOf(a: Pick<Artist, "conviction_score" | "stickiness_score">): number {
  return Math.round((normConviction(a) * normStickiness(a)) / 10);
}

/**
 * Discovery Matrix dot diameter (px) — encodes obscurity on a log10 listener
 * scale: more obscure ⇒ bigger dot. 7px (mainstream, ≥25K) → 21px (deepest, ≤100).
 */
export function obscurityDotSize(listeners: number): number {
  const HI = Math.log10(25000);
  const LO = Math.log10(100);
  const clamped = Math.max(100, Math.min(25000, listeners || 100));
  const t = (HI - Math.log10(clamped)) / (HI - LO);
  return 7 + t * 14;
}

/**
 * Formats a raw Last.fm listener count into a compact label (e.g. "14K").
 * Shared by the ledger, the expanded card, and the hero picks so every
 * surface renders the exact same digits.
 */
export function formatListeners(n: number): string {
  if (!n) return "—";
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

/**
 * Returns a human-readable depth tier label for a given obscurity score (0–100).
 * Optionally appends the user's dominant genre when it has significant weight.
 */
export function getDepthProse(score: number, topGenre?: string): string {
  let tier: string;
  if (score >= 85)      tier = "collector-grade";
  else if (score >= 70) tier = "devoted listener";
  else if (score >= 55) tier = "adventurous";
  else if (score >= 40) tier = "eclectic";
  else                  tier = "wide listener";

  return topGenre ? `${tier}, ${topGenre} focus` : tier;
}
