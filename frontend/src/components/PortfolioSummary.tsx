"use client";

import { useState } from "react";
import { GenreWeight } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";

interface PortfolioSummaryProps {
  genres: GenreWeight[];
  seedsAnalyzed: number;
  totalPool: number;
  deepestDate?: string;
  depthScore?: number;
}

export default function PortfolioSummary({ genres, seedsAnalyzed, totalPool, deepestDate, depthScore }: PortfolioSummaryProps) {
  if (genres.length === 0) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.2 }}
      className="w-full bg-white/40 dark:bg-cyan-950/20 border border-emerald-500/10 dark:border-cyan-500/10 rounded-[2.5rem] dark:rounded-none p-8 lg:p-12 shadow-[0_4px_40px_rgba(0,0,0,0.02)] transition-all duration-1000 relative overflow-hidden backdrop-blur-md"
    >
      {/* Bioluminescent Pulse (Dark Mode) */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_rgba(6,182,212,0.05)_0%,_transparent_100%)] dark:block hidden" />

      <div className="flex flex-col md:flex-row justify-between items-end gap-8 mb-10 pb-10 border-b border-emerald-500/10 dark:border-cyan-500/10 relative z-10">
        
        <div className="flex flex-col gap-3">
          <h2 className="text-3xl md:text-4xl font-serif dark:font-mono italic dark:not-italic text-neutral-900 dark:text-cyan-50 tracking-tight transition-all duration-1000">
             Discovery Summary
          </h2>
          <p className="text-[10px] tracking-[0.4em] text-emerald-600/60 dark:text-cyan-500/40 font-black uppercase transition-all duration-1000">
             {totalPool} Artists Analyzed
          </p>
        </div>

        {/* METRIC BADGES (Solarpunk / Lunarpunk Mode-Agnostic Copy) */}
        <div className="flex gap-10 lg:gap-14 bg-emerald-500/5 dark:bg-black/40 px-8 py-5 rounded-3xl dark:rounded-none border border-emerald-500/10 dark:border-cyan-500/20 shadow-inner overflow-hidden">
          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-widest text-emerald-600/40 dark:text-cyan-500/40 font-black mb-1 transition-all">Seeds</span>
            <span className="text-lg font-light dark:font-mono text-emerald-800 dark:text-cyan-400">[{seedsAnalyzed}]</span>
          </div>

          <div className="w-[1px] h-8 bg-emerald-500/10 dark:bg-cyan-500/10" />

          <div className="flex flex-col items-center">
            <span className="text-[9px] uppercase tracking-widest text-emerald-600/40 dark:text-cyan-500/40 font-black mb-1 transition-all">Depth</span>
            <span className="text-lg font-light dark:font-mono text-neutral-800 dark:text-cyan-400">{deepestDate?.split(',')[0]}</span>
          </div>

        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-y-10 gap-x-16 relative z-10">
        {genres.map((genre, idx) => (
          <motion.div 
            key={genre.name}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 * idx, duration: 1 }}
            className="flex flex-col"
          >
            <div className="flex justify-between items-end mb-4 pr-1">
              <span className="text-sm font-sans dark:font-mono text-emerald-900 dark:text-cyan-50/80 tracking-tight font-light transition-all">
                {genre.name}
              </span>
              <span className="text-[10px] font-mono text-emerald-600/40 dark:text-cyan-500/30 tracking-widest uppercase font-black transition-all">
                {genre.weight.toFixed(1)}%
              </span>
            </div>
            {/* Solar / Lunar Progress */}
            <div className="w-full h-[3px] bg-emerald-500/5 dark:bg-white/5 rounded-full overflow-hidden transition-all">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${genre.weight}%` }}
                transition={{ delay: 1, duration: 2, ease: "easeOut" }}
                className="h-full bg-emerald-600 dark:bg-cyan-400 transition-all shadow-[0_0_8px_rgba(6,182,212,0.2)]" 
              />
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
