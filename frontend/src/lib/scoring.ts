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
