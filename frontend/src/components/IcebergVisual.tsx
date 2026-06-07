"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { Artist } from "../app/page";

type IcebergVisualProps = {
  artists: Artist[];
};

// D7: deterministic hash so node positions are stable across re-renders
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

    const maxScore = Math.max(...artists.map(a => a.stickiness_score));
    const minScore = Math.min(...artists.map(a => a.stickiness_score));

    return artists.map((artist, index) => {
      const range = maxScore - minScore === 0 ? 1 : maxScore - minScore;
      const normalizedScore = (artist.stickiness_score - minScore) / range;
      const topPercentage = 10 + (normalizedScore * 80);

      // Hash-seeded horizontal position — stable across re-renders (no Math.random)
      const leftPercentage = 15 + ((hashStr(artist.name) % 700) / 700) * 70;
      // Hash-seeded float duration for organic variation without hydration mismatch
      const floatDuration = 5 + ((hashStr(artist.name + "_d") % 200) / 100);

      return { ...artist, topPercentage, leftPercentage, floatDuration, index };
    });
  }, [artists]);

  return (
    <div className="relative w-full h-[600px] bg-[#001220] overflow-hidden rounded-lg border border-blue-900/40 shadow-inner">
      <div className="absolute inset-0 bg-gradient-to-b from-blue-500/10 via-blue-900/40 to-black pointer-events-none z-10" />
      <div className="absolute top-[8%] left-0 w-full h-[1px] bg-blue-300/30 z-0 shadow-[0_0_15px_rgba(147,197,253,0.6)]" />
      <span className="absolute top-[2%] right-4 text-xs tracking-widest text-blue-300/50 uppercase font-mono">
        SURFACE_LEVEL
      </span>
      <span className="absolute bottom-[2%] right-4 text-xs tracking-widest text-blue-900 uppercase font-mono z-20">
        ABYSSAL_ZONE
      </span>

      {depthMapping.map((artist) => (
        <motion.div
          key={artist.name}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: [0, -8, 0] }}
          transition={{
            duration: artist.floatDuration,
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut",
            delay: artist.index * 0.15,
          }}
          className="absolute z-20 flex flex-col items-center group cursor-pointer"
          style={{
            top: `${artist.topPercentage}%`,
            left: `${artist.leftPercentage}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)] group-hover:scale-[2] group-hover:bg-white transition-transform duration-300" />
          <div className="mt-3 flex flex-col items-center bg-black/70 backdrop-blur-md px-3 py-1.5 rounded border border-cyan-800/60 opacity-60 group-hover:opacity-100 transition-opacity duration-300">
            <span className="text-[13px] font-bold text-cyan-50 whitespace-nowrap drop-shadow-md">
              {artist.name}
            </span>
            <span className="text-[10px] text-cyan-300/80 tracking-widest font-mono mt-0.5">
              STICKINESS: {artist.stickiness_score.toFixed(1)}
            </span>
          </div>
        </motion.div>
      ))}

      {artists.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-20 text-blue-400/50 tracking-widest uppercase text-sm animate-pulse font-mono">
          AWAITING_SONAR_DATA...
        </div>
      )}
    </div>
  );
}
