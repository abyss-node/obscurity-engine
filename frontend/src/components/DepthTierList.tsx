"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Artist } from "../app/page";

type DepthTierListProps = {
  artists: Artist[];
  onArtistClick?: (name: string) => void;
};

type Tier = {
  label: string;
  sublabel: string;
  min: number;
  max: number;
  /** Background lightness step — tiers get progressively dimmer top→bottom. */
  bg: string;
};

// Thresholds inherited from the original IcebergVisual depth mapping so the
// SURFACE / MID / DEEP / ABYSS semantics stay consistent across the app
// (the page.tsx "depth map" tooltip documents these exact bands).
const TIERS: Tier[] = [
  { label: "SURFACE", sublabel: "10K+ listeners", min: 10_000, max: Infinity, bg: "rgba(255,255,255,0.025)" },
  { label: "MID",     sublabel: "3K–10K",          min: 3_000,  max: 10_000,  bg: "rgba(255,255,255,0.015)" },
  { label: "DEEP",    sublabel: "500–3K",          min: 500,    max: 3_000,   bg: "rgba(0,0,0,0.15)"        },
  { label: "ABYSS",   sublabel: "<500 listeners",  min: 0,      max: 500,     bg: "rgba(0,0,0,0.3)"         },
];

function formatListeners(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

export default function DepthTierList({ artists, onArtistClick }: DepthTierListProps) {
  const grouped = useMemo(() => {
    return TIERS.map((tier) => ({
      tier,
      artists: artists.filter(
        (a) => a.total_listeners >= tier.min && a.total_listeners < tier.max
      ),
    })).filter((g) => g.artists.length > 0);
  }, [artists]);

  if (artists.length === 0) {
    return (
      <div
        className="w-full flex items-center justify-center py-10 font-mono text-[10px] tracking-widest uppercase animate-pulse"
        style={{ color: "var(--dim)" }}
      >
        awaiting sonar data...
      </div>
    );
  }

  // Continuous rank across all tiers, top→bottom.
  let rank = 0;

  return (
    <div className="w-full border" style={{ borderColor: "var(--border)" }}>
      {grouped.map(({ tier, artists: tierArtists }, i) => (
        <section
          key={tier.label}
          className={i < grouped.length - 1 ? "border-b" : ""}
          style={{ borderColor: "var(--border)", background: tier.bg }}
        >
          {/* Tier header */}
          <div
            className="flex items-baseline gap-3 px-4 py-3 border-b"
            style={{ borderColor: "var(--border)" }}
          >
            <span
              className="font-mono text-[9px] tracking-widest uppercase"
              style={{ color: tier.label === "ABYSS" ? "var(--accent)" : "var(--dim)" }}
            >
              {tier.label}
            </span>
            <span
              className="font-mono text-[9px] tracking-wider"
              style={{ color: "var(--dim)", opacity: 0.6 }}
            >
              {tier.sublabel}
            </span>
            <span
              className="font-mono text-[9px] tracking-wider ml-auto"
              style={{ color: "var(--dim)", opacity: 0.6 }}
            >
              {tierArtists.length}
            </span>
          </div>

          {/* Artist rows */}
          <div className="flex flex-col">
            {tierArtists.map((artist) => {
              rank += 1;
              const thisRank = rank;
              return (
                <motion.button
                  key={artist.name}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: Math.min(thisRank, 24) * 0.012 }}
                  onClick={() => onArtistClick?.(artist.name)}
                  className="group flex items-baseline gap-3 px-4 py-2 text-left transition-opacity duration-150 hover:opacity-60"
                >
                  <span
                    className="font-mono text-[9px] tracking-widest shrink-0 w-7"
                    style={{ color: "var(--dim)" }}
                  >
                    /{thisRank.toString().padStart(2, "0")}
                  </span>
                  <span
                    className="font-serif text-sm leading-tight flex-1 min-w-0 truncate"
                    style={{ color: "var(--text)" }}
                  >
                    {artist.name}
                  </span>
                  <span
                    className="font-mono text-[10px] tracking-wider shrink-0 text-right tabular-nums"
                    style={{ color: "var(--dim)" }}
                  >
                    {formatListeners(artist.total_listeners)}
                  </span>
                </motion.button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
