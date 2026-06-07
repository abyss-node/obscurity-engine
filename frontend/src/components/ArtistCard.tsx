"use client";

import { useState } from "react";
import { Artist } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";

interface ArtistCardProps {
  artist: Artist;
  rank: number;
  stickinessThreshold: number;
  isHero?: boolean;
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      stiffness: 100,
      damping: 20,
      duration: 0.8,
    },
  },
};

export default function ArtistCard({ artist, rank, stickinessThreshold, isHero }: ArtistCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isHighConviction = artist.conviction_score >= 250;

  return (
    <motion.div
      layout
      variants={itemVariants}
      onClick={() => setIsExpanded(!isExpanded)}
      whileHover={{ y: -4, boxShadow: "0 20px 40px rgba(0,0,0,0.06)" }}
      className={`relative backdrop-blur-sm transition-all duration-1000 cursor-pointer overflow-hidden flex flex-col group
        ${isHero
          ? "bg-white/80 dark:bg-cyan-950/30 border border-emerald-500/20 dark:border-cyan-400/30 rounded-[2.5rem] dark:rounded-none p-10 md:p-14 shadow-[0_8px_40px_rgba(0,0,0,0.04)] dark:shadow-[0_0_40px_rgba(6,182,212,0.08)]"
          : "bg-white/60 dark:bg-cyan-950/20 border border-emerald-500/10 dark:border-cyan-500/20 rounded-[2.5rem] dark:rounded-none p-8 md:p-10 shadow-[0_4px_25px_rgba(0,0,0,0.02)] dark:shadow-[0_0_20px_rgba(6,182,212,0.05)]"
        }`}
    >
      {/* Visual Marker for Mode-Agnostic identity */}
      <div className="flex flex-col gap-4">
        {/* Header: Name and Rank */}
        <div className="flex justify-between items-start leading-relaxed">
          <div className="flex flex-col gap-1 pr-6 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={`font-serif dark:font-mono italic dark:not-italic text-neutral-900 dark:text-cyan-50 leading-[1.4] transition-all duration-1000 ${isHero ? "text-3xl md:text-5xl" : "text-2xl"}`}>
                {artist.name}
              </h3>
              {isHighConviction && (
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.5)]" />
              )}
              {artist.cross_validated && (
                <span className="text-[8px] font-mono tracking-widest text-cyan-400 border border-cyan-500/30 px-1.5 py-0.5">
                  DUAL_SIGNAL
                </span>
              )}
            </div>
            
            {/* Minimalist Vibe Tag */}
            <div className="flex flex-wrap gap-2 mt-2">
               <span className="text-[10px] font-sans dark:font-mono tracking-[0.2em] text-emerald-600/70 dark:text-cyan-400/60 uppercase font-black leading-loose transition-all duration-1000">
                  {artist.top_tags[0] || "Unknown Vibe"}
               </span>
               <AnimatePresence>
                 {isExpanded && artist.top_tags.slice(1, 4).map(tag => (
                   <motion.span 
                    key={tag}
                    initial={{ opacity: 0, x: -5 }} animate={{ opacity: 1, x: 0 }}
                    className="text-[10px] font-sans dark:font-mono tracking-[0.2em] text-emerald-500/40 dark:text-cyan-500/40 uppercase font-medium leading-loose transition-all"
                   >
                     {tag}
                   </motion.span>
                 ))}
               </AnimatePresence>
            </div>
          </div>
          
          <div className="text-[9px] font-mono tracking-widest text-emerald-600/20 dark:text-cyan-500/20 font-black mt-2 transition-all">
            /{rank.toString().padStart(2, '0')}
          </div>
        </div>

        {/* Expandable Body: Original Copy Reinstated */}
        <motion.div 
          layout
          initial={false}
          animate={{ height: isExpanded ? "auto" : 0, opacity: isExpanded ? 1 : 0 }}
          className="overflow-hidden"
        >
          <div className="mt-8 pt-8 border-t border-emerald-500/10 dark:border-cyan-500/10 flex flex-col gap-6">
            <div className="grid grid-cols-2 gap-8">
               <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-widest text-emerald-600/40 dark:text-cyan-500/40 font-black mb-1 transition-all">Conviction</span>
                  <span className="text-lg font-light dark:font-mono text-emerald-700 dark:text-cyan-400 leading-relaxed transition-all">{(artist.conviction_score / 100).toFixed(2)}</span>
               </div>
               <div className="flex flex-col border-l border-emerald-500/10 dark:border-cyan-500/10 pl-8">
                  <span className="text-[9px] uppercase tracking-widest text-emerald-600/40 dark:text-cyan-500/40 font-black mb-1 transition-all">Stickiness</span>
                  <span className="text-lg font-light dark:font-mono text-emerald-700 dark:text-cyan-400 leading-relaxed transition-all">{artist.stickiness_score.toFixed(2)}</span>
               </div>
            </div>

            {(artist.taste_alignment ?? 0) > 0 && (
              <div className="flex flex-col">
                <span className="text-[9px] uppercase tracking-widest text-emerald-600/40 dark:text-cyan-500/40 font-black mb-1 transition-all">Genre Fit</span>
                <span className="text-lg font-light dark:font-mono text-emerald-700 dark:text-cyan-400 leading-relaxed transition-all">
                  {Math.round((artist.taste_alignment ?? 0) * 100)}%
                </span>
              </div>
            )}

            <a
              href={`https://www.last.fm/music/${encodeURIComponent(artist.name)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="w-full py-4 text-center rounded-2xl dark:rounded-none bg-emerald-600 dark:bg-cyan-500 text-white dark:text-black text-[10px] font-bold dark:font-black uppercase tracking-[0.3em] hover:bg-emerald-700 dark:hover:bg-cyan-400 transition-all shadow-lg shadow-emerald-500/5 dark:shadow-cyan-500/5"
            >
              View on Last.fm
            </a>
          </div>
        </motion.div>
      </div>

      {!isExpanded && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[8px] text-emerald-200/50 dark:text-cyan-500/20 font-bold tracking-widest uppercase opacity-0 group-hover:opacity-100 transition-opacity">
          Tap to expand
        </div>
      )}
    </motion.div>
  );
}
