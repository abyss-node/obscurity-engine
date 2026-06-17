"use client";

import { forwardRef } from "react";
import type { Artist, GenreWeight } from "../app/page";
import { firstGenreTag } from "../lib/geoTags";

// 660 × 860 shareable result card (§8). Rendered off-screen by page.tsx and
// snapshot to PNG via html-to-image. All styling is inline so the snapshot
// doesn't depend on Tailwind's stylesheet being inlined — only the web fonts.

function formatListeners(n: number): string {
  if (!n) return "—";
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

const PLAYFAIR = "var(--font-playfair), Georgia, serif";
const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif"; // IBM Plex Serif (body)

interface ShareCardProps {
  username: string;
  depthScore: number;
  verdict: string; // already-built prose (e.g. "collector-grade, death metal focus")
  artists: Artist[];
  topGenres: GenreWeight[];
  activeSeedCount: number;
}

const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(function ShareCard(
  { username, depthScore, verdict, artists, topGenres, activeSeedCount },
  ref
) {
  // "Deepest finds" = the most obscure discoveries (lowest listener counts).
  const finds = [...artists]
    .sort((a, b) => a.total_listeners - b.total_listeners)
    .slice(0, 3);

  const genres = topGenres.slice(0, 4);
  const underCount = artists.filter((a) => a.total_listeners < 25000).length;
  const verdictCapped = verdict ? verdict.charAt(0).toUpperCase() + verdict.slice(1) : "";

  return (
    <div
      ref={ref}
      style={{
        width: 660,
        background: "#080806",
        border: "1px solid #2A2824",
        padding: 48,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      {/* header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 500, letterSpacing: "0.24em", color: "#B8832E" }}>
          OBSCURITY ENGINE
        </span>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: "#4A4640" }}>
          obscurity-engine.vercel.app
        </span>
      </div>

      {/* index */}
      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "#4A4640" }}>
          {username} · obscurity index
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <span
            style={{
              fontFamily: PLAYFAIR,
              fontStyle: "italic",
              fontWeight: 700,
              fontSize: 132,
              lineHeight: 0.8,
              color: "#B8832E",
              letterSpacing: "-0.03em",
            }}
          >
            {depthScore.toFixed(0)}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 14, color: "#4A4640" }}>/ 100</span>
        </div>
        {verdictCapped && (
          <p style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 21, color: "#EDE8DC", marginTop: 8 }}>
            {verdictCapped}.
          </p>
        )}
      </div>

      {/* deepest finds */}
      <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 14 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: "#4A4640" }}>
          deepest finds
        </span>
        {finds.map((f) => (
          <div
            key={f.name}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 16,
              paddingBottom: 12,
              borderBottom: "1px solid #1A1916",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
              {f.cross_validated && <span style={{ color: "#B8832E", fontSize: 11 }}>✦</span>}
              <span style={{ fontFamily: PLAYFAIR, fontWeight: 600, fontSize: 22, color: "#EDE8DC" }}>{f.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "#7A7265" }}>
                {firstGenreTag(f.top_tags)}
              </span>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 11, color: "#4A4640", whiteSpace: "nowrap" }}>
              {formatListeners(f.total_listeners)}
            </span>
          </div>
        ))}
      </div>

      {/* taste signature */}
      <div style={{ marginTop: 32, display: "flex", flexWrap: "wrap", gap: 6 }}>
        {genres.map((g) => (
          <span
            key={g.name}
            style={{ fontFamily: MONO, fontSize: 10, color: "#7A7265", padding: "4px 11px", border: "1px solid #2A2824" }}
          >
            {g.name} {Math.round(g.weight)}%
          </span>
        ))}
      </div>

      <span style={{ marginTop: 36, fontFamily: MONO, fontSize: 10, letterSpacing: "0.06em", color: "#4A4640" }}>
        mapped from {activeSeedCount} seeds · {underCount} finds under 25K listeners
      </span>
    </div>
  );
});

export default ShareCard;
