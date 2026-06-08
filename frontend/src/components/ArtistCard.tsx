"use client";

import { useState, useEffect, useRef } from "react";
import { Artist } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";
import Tooltip from "./Tooltip";
import { firstGenreTag, isGeoTag, formatGeoTag } from "../lib/geoTags";

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
    transition: {
      type: "spring" as const,
      stiffness: 80,
      damping: 20,
    },
  },
};

export default function ArtistCard({ artist, rank, isHero, isFocused }: ArtistCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused) {
      setIsExpanded(true);
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [isFocused]);

  const primaryTag = firstGenreTag(artist.top_tags);
  const geoTags = artist.top_tags.filter(t => isGeoTag(t)).slice(0, 2);
  const extraTags = artist.top_tags.filter(t => !isGeoTag(t)).slice(1, 5);

  const conviction = Math.min(artist.conviction_score / 100, 10).toFixed(1);
  const stickiness = Math.min(Math.log10(artist.stickiness_score + 1) / Math.log10(101) * 10, 10).toFixed(1);
  const genreFit = Math.round((artist.taste_alignment ?? 0) * 100);

  return (
    <motion.div
      ref={cardRef}
      layout
      variants={itemVariants}
      onClick={() => setIsExpanded(!isExpanded)}
      className={`relative cursor-pointer border transition-colors duration-150 flex flex-col
        ${isHero ? "p-10 md:p-14" : "p-6"}`}
      style={{ background: "var(--surface)", borderColor: isFocused ? "var(--accent)" : "var(--border)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--dim)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = isFocused ? "var(--accent)" : "var(--border)")}
    >
      <div className="flex flex-col gap-3">
        {/* Header row */}
        <div className="flex justify-between items-start gap-3">
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

            {/* Primary genre + geo — always visible */}
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

          {/* Rank */}
          <span className="font-mono text-[9px] tracking-widest shrink-0 mt-1" style={{ color: "var(--dim)" }}>
            /{rank.toString().padStart(2, "0")}
          </span>
        </div>

        {/* Expandable details */}
        <motion.div
          layout
          initial={false}
          animate={{ height: isExpanded ? "auto" : 0, opacity: isExpanded ? 1 : 0 }}
          className="overflow-hidden"
        >
          <div className="mt-4 pt-5 border-t flex flex-col gap-5" style={{ borderColor: "var(--border)" }}>

            {/* Extra genre tags */}
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

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>conviction</span>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {conviction}<span className="text-[10px]" style={{ color: "var(--dim)" }}>/10</span>
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>stickiness</span>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {stickiness}<span className="text-[10px]" style={{ color: "var(--dim)" }}>/10</span>
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>listeners</span>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {formatListeners(artist.total_listeners)}
                </span>
              </div>
              {genreFit > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>genre fit</span>
                  <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                    {genreFit}%
                  </span>
                </div>
              )}
            </div>

            {/* Source seeds */}
            {artist.source_seeds && artist.source_seeds.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>via</span>
                <div className="flex flex-wrap gap-2">
                  {artist.source_seeds.slice(0, 4).map(s => (
                    <span key={s.name} className="font-mono text-[10px]" style={{ color: "var(--muted)" }}>
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <a
              href={`https://www.last.fm/music/${encodeURIComponent(artist.name)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="w-full py-3 text-center border font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-70"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            >
              view on last.fm →
            </a>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
