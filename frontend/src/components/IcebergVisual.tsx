"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { Artist } from "../app/page"; // We will export the type from page.tsx

type IcebergVisualProps = {
  artists: Artist[];
};

export default function IcebergVisual({ artists }: IcebergVisualProps) {
  // We map stickiness_score to Y positions (percentages)
  // Higher score = more sticky/cult-like = deeper in the iceberg.
  const depthMapping = useMemo(() => {
    if (artists.length === 0) return [];
    
    // Find min and max to normalize scores between 0 and 1
    const maxScore = Math.max(...artists.map(a => a.stickiness_score));
    const minScore = Math.min(...artists.map(a => a.stickiness_score));
    
    return artists.map((artist, index) => {
      const range = maxScore - minScore === 0 ? 1 : maxScore - minScore;
      
      // Normalized score: 1 means highest stickiness_score (most sticky/cult-like), 0 means lowest.
      const normalizedScore = (artist.stickiness_score - minScore) / range;
      
      // Map normalized score to a vertical percentage placement.
      // 10% from the top (shallow) to 90% (deepest)
      // Since high score means deeper, we place it close to 90%.
      const topPercentage = 10 + (normalizedScore * 80);
      
      // Spread them horizontally
      const leftPercentage = 15 + Math.random() * 70;
      
      return {
        ...artist,
        topPercentage,
        leftPercentage,
      };
    });
  }, [artists]);

  return (
    <div className="relative w-full h-[600px] bg-[#001220] overflow-hidden rounded-lg border border-blue-900/40 shadow-inner">
      {/* Underwater Depth Gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-blue-500/10 via-blue-900/40 to-black pointer-events-none z-10" />

      {/* Surface dividing line overlay */}
      <div className="absolute top-[8%] left-0 w-full h-[1px] bg-blue-300/30 z-0 shadow-[0_0_15px_rgba(147,197,253,0.6)]" />
      <span className="absolute top-[2%] right-4 text-xs tracking-widest text-blue-300/50 uppercase font-mono">
        SURFACE_LEVEL
      </span>
      <span className="absolute bottom-[2%] right-4 text-xs tracking-widest text-blue-900 uppercase font-mono z-20">
        ABYSSAL_ZONE
      </span>

      {depthMapping.map((artist, idx) => (
        <motion.div
          key={`${artist.name}-${idx}`}
          initial={{ opacity: 0, y: 30 }}
          animate={{
            opacity: 1,
            y: [0, -8, 0], // Subtle continuous floating effect
          }}
          transition={{
            duration: 5 + Math.random() * 2, // Randomize float speed slightly for organic feel
            repeat: Infinity,
            repeatType: "reverse",
            ease: "easeInOut",
            delay: idx * 0.15, // Staggered entrance
          }}
          className="absolute z-20 flex flex-col items-center group cursor-pointer"
          style={{
            top: `${artist.topPercentage}%`,
            left: `${artist.leftPercentage}%`,
            transform: `translate(-50%, -50%)`,
          }}
        >
          {/* Glowing Node Point */}
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)] group-hover:scale-[2] group-hover:bg-white transition-transform duration-300" />
          
          {/* Artist Tag Details */}
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
