"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Artist } from "../app/page";

type IcebergVisualProps = {
  artists: Artist[];
};

type Tier = {
  label: string;
  sublabel: string;
  min: number;
  max: number;
};

const TIERS: Tier[] = [
  { label: "SURFACE", sublabel: "10K+ listeners",  min: 10_000, max: Infinity },
  { label: "MID",     sublabel: "3K–10K",           min: 3_000,  max: 10_000  },
  { label: "DEEP",    sublabel: "500–3K",            min: 500,    max: 3_000   },
  { label: "ABYSS",   sublabel: "<500 listeners",    min: 0,      max: 500     },
];

function formatListeners(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

export default function IcebergVisual({ artists }: IcebergVisualProps) {
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

  return (
    <div
      className="w-full border"
      style={{ borderColor: "var(--border)" }}
    >
      {grouped.map(({ tier, artists: tierArtists }, i) => (
        <div
          key={tier.label}
          className={`flex ${i < grouped.length - 1 ? "border-b" : ""}`}
          style={{ borderColor: "var(--border)" }}
        >
          {/* Tier label */}
          <div
            className="w-24 shrink-0 flex flex-col justify-start items-end gap-1 py-4 pr-4 border-r"
            style={{ borderColor: "var(--border)" }}
          >
            <span
              className="font-mono text-[9px] tracking-widest uppercase"
              style={{
                color:
                  tier.label === "ABYSS"
                    ? "var(--accent)"
                    : tier.label === "DEEP"
                    ? "var(--text)"
                    : "var(--dim)",
              }}
            >
              {tier.label}
            </span>
            <span
              className="font-mono text-[8px] tracking-wider"
              style={{ color: "var(--dim)", opacity: 0.5 }}
            >
              {tier.sublabel}
            </span>
          </div>

          {/* Artists in this tier */}
          <div className="flex flex-wrap gap-x-5 gap-y-3 p-4 flex-1">
            {tierArtists.map((artist, j) => (
              <motion.div
                key={artist.name}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: j * 0.03 }}
                className="flex flex-col gap-0.5"
              >
                <span
                  className="font-mono text-[11px] leading-tight"
                  style={{ color: "var(--text)" }}
                >
                  {artist.name}
                </span>
                <span
                  className="font-mono text-[9px] tracking-wider"
                  style={{ color: "var(--dim)" }}
                >
                  {formatListeners(artist.total_listeners)}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
