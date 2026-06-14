"use client";

import { useEffect, useRef } from "react";
import { Artist } from "../app/page";
import { motion } from "framer-motion";
import Tooltip from "./Tooltip";
import { firstGenreTag, isGeoTag, formatGeoTag, GEO_CANONICAL } from "../lib/geoTags";

function formatListeners(n: number): string {
  if (n === 0) return "unknown";
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

interface ArtistCardProps {
  artist: Artist;
  rank: number;
  stickinessThreshold: number;
  isHero?: boolean;
  isFocused?: boolean;
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 80, damping: 20 },
  },
};

const StatCell = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
  <div className="flex flex-col gap-0.5">
    <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>{label}</span>
    <span className="font-mono text-base" style={{ color: "var(--text)" }}>
      {value}{unit && <span className="text-[10px]" style={{ color: "var(--dim)" }}>{unit}</span>}
    </span>
  </div>
);

export default function ArtistCard({ artist, rank, isHero, isFocused }: ArtistCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused) {
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [isFocused]);

  const primaryTag = firstGenreTag(artist.top_tags);
  const geoTags = (() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of artist.top_tags) {
      if (!isGeoTag(t)) continue;
      const canonical = GEO_CANONICAL.get(t.toLowerCase()) ?? t.toLowerCase();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push(canonical);
      if (result.length >= 2) break;
    }
    return result;
  })();
  const extraTags = artist.top_tags.filter(t => !isGeoTag(t) && t.length <= 25).slice(1, 8);

  const conviction = Math.round(Math.min(artist.conviction_score / 100, 10) * 10);
  const stickiness = Math.round(Math.min(Math.log10(artist.stickiness_score + 1) / Math.log10(101) * 10, 10) * 10);
  const genreFit = Math.round((artist.taste_alignment ?? 0) * 100);
  const hasSeeds = artist.source_seeds && artist.source_seeds.length > 0;

  const lastfmUrl = `https://www.last.fm/music/${encodeURIComponent(artist.name)}`;

  return (
    <motion.div
      ref={cardRef}
      layout
      variants={itemVariants}
      className={`group relative border flex flex-col h-full cursor-default
        ${isHero ? "p-7 md:p-10" : "p-5"}`}
      style={{ background: "var(--surface)", borderColor: isFocused ? "var(--accent)" : "var(--border)" }}
      onMouseEnter={!isHero ? (e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--dim)") : undefined}
      onMouseLeave={!isHero ? (e) => ((e.currentTarget as HTMLElement).style.borderColor = isFocused ? "var(--accent)" : "var(--border)") : undefined}
    >
      <div className="flex flex-col gap-4 flex-1">

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="flex justify-between items-start gap-3">
          <div className="flex flex-col min-w-0 flex-1">

            {/* Name + geo tag — fixed height on grid cards */}
            <div className={isHero ? "" : "h-[56px] md:h-[68px] overflow-hidden"}>
              <a
                href={lastfmUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={`font-serif font-semibold leading-tight hover:opacity-70 transition-opacity duration-150 ${
                  isHero ? "text-3xl md:text-5xl" : "text-xl md:text-2xl"
                }`}
                style={{ color: "var(--text)" }}
              >
                {artist.name}
              </a>
              {!isHero && geoTags.length > 0 && (
                <div className="flex gap-2 mt-0.5">
                  {geoTags.map(tag => (
                    <span key={tag} className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                      {formatGeoTag(tag.toLowerCase())}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Genre row: star + primary tag */}
            <div className={isHero
              ? "mt-3 flex items-center gap-3"
              : "mt-2 flex items-center gap-2 min-h-[20px]"
            }>
              {artist.cross_validated && (
                <Tooltip text="Confirmed by both your similar-artists graph and the genre tag graph.">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    className="shrink-0"
                    style={{ width: 13, height: 13, fill: "var(--accent)" }}
                    aria-label="Dual-confirmed"
                  >
                    <path d="M8 1l1.854 3.756 4.146.603-3 2.924.708 4.126L8 10.25l-3.708 1.159.708-4.126-3-2.924 4.146-.603z" />
                  </svg>
                </Tooltip>
              )}
              {primaryTag && (
                <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--muted)" }}>
                  {primaryTag}
                </span>
              )}
              {isHero && geoTags.map(tag => (
                <span key={tag} className="font-mono text-[9px] tracking-widest uppercase shrink-0" style={{ color: "var(--dim)" }}>
                  {formatGeoTag(tag.toLowerCase())}
                </span>
              ))}
            </div>

            {/* Listeners / extra genre tags — cross-fade on hover */}
            <div className={isHero ? "mt-1" : "relative h-[56px] mt-1.5"}>
              {/* Listeners: vertically centered, fades out on hover */}
              <span
                className={`font-mono text-[10px] tracking-wider ${!isHero ? "absolute inset-0 flex items-center transition-opacity duration-150 group-hover:opacity-0" : ""}`}
                style={{ color: "var(--dim)" }}
              >
                {formatListeners(artist.total_listeners)} listeners
              </span>
              {/* Extra genre tags: 3 rows, smaller font, fade in on hover */}
              {!isHero && extraTags.length > 0 && (
                <div className="absolute inset-0 flex flex-wrap gap-x-3 gap-y-1 content-start overflow-hidden opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  {extraTags.map(tag => (
                    <span key={tag} className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

          </div>

          <span className="font-mono text-[9px] tracking-widest shrink-0" style={{ color: "var(--dim)", marginTop: isHero ? 0 : "4px" }}>
            /{rank.toString().padStart(2, "0")}
          </span>
        </div>

        {/* ── Hero body ─────────────────────────────────────────────────────── */}
        {isHero && (
          <div className="pt-5 border-t flex flex-col gap-5" style={{ borderColor: "var(--border)" }}>
            <div className="grid gap-6 grid-cols-3">
              <StatCell label="conviction" value={`${conviction}%`} />
              <StatCell label="genre fit" value={genreFit > 0 ? `${genreFit}%` : "—"} />
              <StatCell label="stickiness" value={`${stickiness}%`} />
            </div>
            {extraTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {extraTags.map(tag => (
                  <span
                    key={tag}
                    className="font-mono text-[9px] tracking-widest uppercase px-2 py-0.5 border"
                    style={{ color: "var(--dim)", borderColor: "var(--border)" }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {hasSeeds && (
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>via</span>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                  {artist.source_seeds.slice(0, 5).map(s => (
                    <span key={s.name} className="font-mono text-[10px] leading-tight" style={{ color: "var(--muted)" }}>
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Grid card: stats + hover overlay (tags + via) ─────────────────── */}
        {!isHero && (
          <div className="relative pt-4 border-t min-h-[56px]" style={{ borderColor: "var(--border)" }}>
            {/* Stats — fade out on hover when overlay has content */}
            <div className={`grid grid-cols-3 gap-x-6 gap-y-3 transition-opacity duration-200 ${hasSeeds ? "group-hover:opacity-0" : ""}`}>
              <StatCell label="conviction" value={`${conviction}%`} />
              <StatCell label="genre fit" value={genreFit > 0 ? `${genreFit}%` : "—"} />
              <StatCell label="stickiness" value={`${stickiness}%`} />
            </div>

            {/* Via overlay — fades in on hover */}
            {hasSeeds && (
              <div className="absolute top-4 left-0 right-0 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>via</span>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {artist.source_seeds.slice(0, 5).map(s => (
                    <span key={s.name} className="font-mono text-[10px] leading-tight" style={{ color: "var(--muted)" }}>
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>

      {/* Last.fm — hero only (grid cards use name link) */}
      {isHero && (
        <a
          href={lastfmUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 w-full py-3 text-center border font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-70 shrink-0"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          view on last.fm →
        </a>
      )}
    </motion.div>
  );
}
