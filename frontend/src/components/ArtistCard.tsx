"use client";

import { useState } from "react";
import { Artist } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";
import Tooltip from "./Tooltip";
import { firstGenreTag, isGeoTag, formatGeoTag } from "../lib/geoTags";

function formatListeners(n: number): string {
  if (n === 0) return "unknown listeners";
  if (n < 1000) return `${n} listeners`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K listeners`;
  return `${Math.round(n / 1000)}K listeners`;
}

interface ArtistCardProps {
  artist: Artist;
  rank: number;
  stickinessThreshold: number;
  isHero?: boolean;
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

export default function ArtistCard({ artist, rank, isHero }: ArtistCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <motion.div
      layout
      variants={itemVariants}
      onClick={() => setIsExpanded(!isExpanded)}
      className={`relative cursor-pointer border transition-colors duration-150 flex flex-col
        ${isHero ? "p-10 md:p-14" : "p-6 md:p-8"}`}
      style={{
        background: "var(--surface)",
        borderColor: isExpanded ? "var(--border)" : "var(--border)",
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor = "var(--dim)")
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor = "var(--border)")
      }
    >
      <div className="flex flex-col gap-3">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div className="flex flex-col gap-1 pr-4 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h3
                className={`font-serif font-semibold leading-tight ${
                  isHero ? "text-3xl md:text-5xl" : "text-xl md:text-2xl"
                }`}
                style={{ color: "var(--text)" }}
              >
                {artist.name}
              </h3>
              {artist.cross_validated && (
                <Tooltip text="This artist was independently confirmed by two methods: your similar-artists graph AND the genre tag graph. Higher confidence recommendation.">
                  <span
                    className="font-mono text-[9px] tracking-widest px-1.5 py-0.5 border"
                    style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
                  >
                    DUAL SIGNAL
                  </span>
                </Tooltip>
              )}
            </div>

            <div className="flex flex-wrap gap-3 mt-1">
              <span
                className="font-mono text-[10px] tracking-widest uppercase"
                style={{ color: "var(--muted)" }}
              >
                {firstGenreTag(artist.top_tags)}
              </span>
              {/* Geo tags shown as quiet secondary badges */}
              {artist.top_tags.filter(t => isGeoTag(t)).slice(0, 2).map(tag => (
                <span
                  key={tag}
                  className="font-mono text-[9px] tracking-widest uppercase"
                  style={{ color: "var(--dim)" }}
                >
                  {formatGeoTag(tag.toLowerCase())}
                </span>
              ))}
              <AnimatePresence>
                {isExpanded &&
                  artist.top_tags.filter(t => !isGeoTag(t)).slice(1, 4).map((tag) => (
                    <motion.span
                      key={tag}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="font-mono text-[10px] tracking-widest uppercase"
                      style={{ color: "var(--dim)" }}
                    >
                      {tag}
                    </motion.span>
                  ))}
              </AnimatePresence>
            </div>

            <Tooltip text="Total number of unique listeners on Last.fm. The lower this number, the more underground the artist.">
              <span
                className="font-mono text-[10px] tracking-wider"
                style={{ color: "var(--dim)" }}
              >
                {formatListeners(artist.total_listeners)}
              </span>
            </Tooltip>
          </div>

          <span
            className="font-mono text-[9px] tracking-widest mt-1 shrink-0"
            style={{ color: "var(--dim)" }}
          >
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
          <div
            className="mt-6 pt-6 border-t flex flex-col gap-5"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="grid grid-cols-3 gap-6">
              <div className="flex flex-col gap-1">
                <Tooltip text="How many artists you already love point toward this one.">
                  <span
                    className="font-mono text-[9px] tracking-widest uppercase"
                    style={{ color: "var(--dim)" }}
                  >
                    conviction
                  </span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {(artist.conviction_score / 100).toFixed(2)}
                </span>
              </div>
              <div
                className="flex flex-col gap-1 border-l pl-6"
                style={{ borderColor: "var(--border)" }}
              >
                <Tooltip text="Ratio of monthly to total listeners — high stickiness means people keep coming back.">
                  <span
                    className="font-mono text-[9px] tracking-widest uppercase"
                    style={{ color: "var(--dim)" }}
                  >
                    stickiness
                  </span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {artist.stickiness_score.toFixed(2)}
                </span>
              </div>
              <div
                className="flex flex-col gap-1 border-l pl-6"
                style={{ borderColor: "var(--border)" }}
              >
                <Tooltip text="Total unique listeners on Last.fm globally.">
                  <span
                    className="font-mono text-[9px] tracking-widest uppercase"
                    style={{ color: "var(--dim)" }}
                  >
                    listeners
                  </span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {artist.total_listeners.toLocaleString()}
                </span>
              </div>
            </div>

            {(artist.taste_alignment ?? 0) > 0 && (
              <div className="flex flex-col gap-1">
                <Tooltip text="How well this artist's genre tags overlap with your overall taste profile. 100% = perfect genre match.">
                  <span
                    className="font-mono text-[9px] tracking-widest uppercase"
                    style={{ color: "var(--dim)" }}
                  >
                    genre fit
                  </span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {Math.round((artist.taste_alignment ?? 0) * 100)}%
                </span>
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
