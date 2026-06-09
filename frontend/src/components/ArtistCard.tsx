"use client";

import { useState, useEffect, useRef } from "react";
import { Artist } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";
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
  isExpanded?: boolean;
  onToggle?: () => void;
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 80, damping: 20 },
  },
};

export default function ArtistCard({
  artist,
  rank,
  isHero,
  isFocused,
  isExpanded: controlledExpanded,
  onToggle,
}: ArtistCardProps) {
  const [localExpanded, setLocalExpanded] = useState(isHero ?? false);
  const isExpanded = controlledExpanded ?? localExpanded;
  const toggle = onToggle ?? (() => setLocalExpanded(e => !e));

  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused) {
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [isFocused]);

  const primaryTag = firstGenreTag(artist.top_tags);
  // Normalize all geo tags to their canonical country-name form, deduplicated
  // e.g. "german" → "germany", "swedish" → "sweden", so display is always "Germany" / "Sweden"
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
  const extraTags = artist.top_tags.filter(t => !isGeoTag(t) && t.length <= 25).slice(1, 5);

  const conviction = Math.min(artist.conviction_score / 100, 10).toFixed(1);
  const stickiness = Math.min(Math.log10(artist.stickiness_score + 1) / Math.log10(101) * 10, 10).toFixed(1);
  const genreFit = Math.round((artist.taste_alignment ?? 0) * 100);

  return (
    <motion.div
      ref={cardRef}
      layout
      variants={itemVariants}
      onClick={toggle}
      className={`group relative cursor-pointer border transition-colors duration-150 flex flex-col h-full
        ${isHero ? "p-10 md:p-14" : "p-5"}`}
      style={{ background: "var(--surface)", borderColor: isFocused ? "var(--accent)" : "var(--border)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--dim)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = isFocused ? "var(--accent)" : "var(--border)")}
    >
      <div className="flex flex-col gap-4">

        {/* Header */}
        <div className={`flex justify-between items-start gap-3 ${isHero ? "" : "min-h-[110px]"}`}>
          <div className="flex flex-col gap-1.5 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className={`font-serif font-semibold leading-tight break-words ${
                  isHero ? "text-3xl md:text-5xl" : "text-xl md:text-2xl"
                }`}
                style={{ color: "var(--text)" }}
              >
                {artist.name}
              </h3>
              {artist.cross_validated && (
                <Tooltip text="Confirmed by both your similar-artists graph and the genre tag graph.">
                  <span
                    className="font-mono text-[9px] tracking-widest px-1.5 py-0.5 border shrink-0"
                    style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
                  >
                    DUAL
                  </span>
                </Tooltip>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {primaryTag && (
                <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--muted)" }}>
                  {primaryTag}
                </span>
              )}
              {geoTags.map(tag => (
                <span key={tag} className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                  {formatGeoTag(tag.toLowerCase())}
                </span>
              ))}
            </div>
            <span className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
              {formatListeners(artist.total_listeners)} listeners
            </span>
          </div>
          <span className="font-mono text-[9px] tracking-widest shrink-0 mt-1" style={{ color: "var(--dim)" }}>
            /{rank.toString().padStart(2, "0")}
          </span>
        </div>

        {/* Stats — always visible, always 2 items so height is consistent across cards */}
        <div className="pt-4 border-t grid grid-cols-2 gap-x-6 gap-y-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>conviction</span>
            <span className="font-mono text-base" style={{ color: "var(--text)" }}>
              {conviction}<span className="text-[10px]" style={{ color: "var(--dim)" }}>/10</span>
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>stickiness</span>
            <span className="font-mono text-base" style={{ color: "var(--text)" }}>
              {stickiness}<span className="text-[10px]" style={{ color: "var(--dim)" }}>/10</span>
            </span>
          </div>
        </div>

        {/* Expandable: genre fit + extra tags + via */}
        <motion.div
          layout
          initial={false}
          animate={{ height: isExpanded ? "auto" : 0, opacity: isExpanded ? 1 : 0 }}
          className="overflow-hidden"
        >
          <div className="pt-4 border-t flex flex-col gap-4" style={{ borderColor: "var(--border)" }}>
            {genreFit > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>genre fit</span>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>{genreFit}%</span>
              </div>
            )}
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
            {/* Via — always in DOM inside expandable, revealed on hover (no layout shift) */}
            {artist.source_seeds && artist.source_seeds.length > 0 && (
              <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col gap-0.5">
                <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>via</span>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {artist.source_seeds.slice(0, 4).map(s => (
                    <span key={s.name} className="font-mono text-[10px] leading-tight" style={{ color: "var(--muted)" }}>
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>

      </div>

      {/* Via — fades in on hover when collapsed */}
      {!isHero && artist.source_seeds && artist.source_seeds.length > 0 && (
        <div
          className={`absolute inset-x-0 bottom-0 flex flex-col gap-1 px-5 pb-5 pt-12 pointer-events-none transition-opacity duration-200
            ${isExpanded ? "opacity-0" : "opacity-0 group-hover:opacity-100"}`}
          style={{ background: "linear-gradient(to top, var(--surface) 60%, transparent)" }}
        >
          <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>via</span>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            {artist.source_seeds.slice(0, 4).map(s => (
              <span key={s.name} className="font-mono text-[10px] leading-tight" style={{ color: "var(--muted)" }}>
                {s.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Last.fm — pinned to card bottom */}
      <AnimatePresence>
        {isExpanded && (
          <motion.a
            href={`https://www.last.fm/music/${encodeURIComponent(artist.name)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-auto pt-4 w-full py-3 text-center border font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-70 shrink-0"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            view on last.fm →
          </motion.a>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
