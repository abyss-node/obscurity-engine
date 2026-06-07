"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { Artist } from "../app/page";

type IcebergVisualProps = {
  artists: Artist[];
};

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) - h) + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export default function IcebergVisual({ artists }: IcebergVisualProps) {
  const depthMapping = useMemo(() => {
    if (artists.length === 0) return [];

    const maxScore = Math.max(...artists.map((a) => a.stickiness_score));
    const minScore = Math.min(...artists.map((a) => a.stickiness_score));

    return artists.map((artist, index) => {
      const range = maxScore - minScore === 0 ? 1 : maxScore - minScore;
      const normalizedScore = (artist.stickiness_score - minScore) / range;
      const topPercentage = 10 + normalizedScore * 80;
      const leftPercentage = 15 + ((hashStr(artist.name) % 700) / 700) * 70;
      const floatDuration = 5 + (hashStr(artist.name + "_d") % 200) / 100;

      return { ...artist, topPercentage, leftPercentage, floatDuration, index };
    });
  }, [artists]);

  return (
    <div
      className="relative w-full h-[520px] overflow-hidden border"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {/* Surface line */}
      <div
        className="absolute top-[10%] left-0 w-full h-px z-0"
        style={{ background: "var(--border)" }}
      />
      <span
        className="absolute top-[4%] right-4 font-mono text-[9px] tracking-widest uppercase z-10"
        style={{ color: "var(--dim)" }}
      >
        surface
      </span>
      <span
        className="absolute bottom-[3%] right-4 font-mono text-[9px] tracking-widest uppercase z-10"
        style={{ color: "var(--dim)" }}
      >
        deep
      </span>

      {depthMapping.map((artist) => (
        <motion.div
          key={artist.name}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: [0, -6, 0] }}
          transition={{
            duration: artist.floatDuration,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut",
            delay: artist.index * 0.12,
          }}
          className="absolute z-20 flex flex-col items-center group cursor-default"
          style={{
            top: `${artist.topPercentage}%`,
            left: `${artist.leftPercentage}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className="w-2 h-2 transition-transform duration-300 group-hover:scale-150"
            style={{ background: "var(--accent)", opacity: 0.7 }}
          />
          <div
            className="mt-2 flex flex-col items-center px-2.5 py-1 border opacity-0 group-hover:opacity-100 transition-opacity duration-200"
            style={{
              background: "var(--surface2)",
              borderColor: "var(--border)",
            }}
          >
            <span
              className="font-mono text-[11px] whitespace-nowrap"
              style={{ color: "var(--text)" }}
            >
              {artist.name}
            </span>
            <span
              className="font-mono text-[9px] tracking-wider mt-0.5"
              style={{ color: "var(--dim)" }}
            >
              {artist.stickiness_score.toFixed(1)}
            </span>
          </div>
        </motion.div>
      ))}

      {artists.length === 0 && (
        <div
          className="absolute inset-0 flex items-center justify-center font-mono text-[10px] tracking-widest uppercase animate-pulse"
          style={{ color: "var(--dim)" }}
        >
          awaiting sonar data...
        </div>
      )}
    </div>
  );
}
