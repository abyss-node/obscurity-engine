"use client";

import { Artist } from "../app/page";
import ArtistCard from "./ArtistCard";
import { motion } from "framer-motion";

interface ArtistListProps {
  artists: Artist[];
  sortBy: string;
  setSortBy: (val: any) => void;
  stickinessThreshold: number;
}

const listVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.3
    }
  }
};

export default function ArtistList({ artists, sortBy, setSortBy, stickinessThreshold }: ArtistListProps) {
  if (artists.length === 0) return null;

  const sortOptions = [
    { id: 'composite', label: 'Composite', icon: '◈' },
    { id: 'conviction', label: 'Conviction', icon: '●' },
    { id: 'stickiness', label: 'Stickiness', icon: '❈' },
    { id: 'listeners', label: 'Listeners', icon: '◎' }
  ];

  return (
    <div className="w-full flex flex-col gap-12 lg:gap-20">
      
      {/* HIGH-END SEGMENTED SORTING */}
      <div className="flex flex-col items-center gap-6">
        <span className="text-[9px] uppercase tracking-[0.5em] text-neutral-400 dark:text-cyan-500/30 font-black mb-2 transition-all duration-1000">
          Ordering Systems
        </span>
        
        <div className="flex flex-wrap justify-center items-center p-2 bg-neutral-50 dark:bg-black/40 border border-neutral-100 dark:border-cyan-500/10 rounded-[2.5rem] dark:rounded-none shadow-inner backdrop-blur-md transition-all duration-1000">
          {sortOptions.map(opt => (
            <button
              key={opt.id}
              onClick={() => setSortBy(opt.id as any)}
              className={`relative flex items-center gap-3 px-6 lg:px-10 py-3 lg:py-4 transition-all duration-700 overflow-hidden
                ${sortBy === opt.id 
                    ? 'text-neutral-900 dark:text-cyan-400 font-bold scale-105' 
                    : 'text-neutral-400 dark:text-cyan-500/20 hover:text-neutral-600 dark:hover:text-cyan-400/50 grayscale'}`}
            >
              {/* Active Indicator (Solar/Lunar Pill) */}
              {sortBy === opt.id && (
                <motion.div 
                  layoutId="activeSort"
                  className="absolute inset-0 bg-white dark:bg-cyan-500/5 rounded-full dark:rounded-none border border-neutral-100 dark:border-cyan-500/30 shadow-sm z-0"
                />
              )}
              
              <span className="relative z-10 text-[10px] md:text-xs font-mono opacity-50">{opt.icon}</span>
              <span className="relative z-10 text-[10px] uppercase tracking-[0.2em] font-black">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* THE GRID: Staggered Reveal */}
      <motion.div 
        variants={listVariants}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 md:gap-12 w-full max-w-7xl mx-auto"
      >
        {artists.map((artist, idx) => (
          <ArtistCard 
            key={`${artist.name}-${idx}`} 
            artist={artist} 
            rank={idx + 1} 
            stickinessThreshold={stickinessThreshold} 
          />
        ))}
      </motion.div>
    </div>
  );
}
