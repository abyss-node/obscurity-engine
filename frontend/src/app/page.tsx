"use client";

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import PortfolioSummary from "../components/PortfolioSummary";
import ArtistList from "../components/ArtistList";

export type Artist = {
  name: string;
  stickiness_score: number;
  conviction_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { name: string; percentile: number; }[];
};

export type GenreWeight = {
  name: string;
  weight: number;
};

export type DiscoveryData = {
  artists: Artist[];
  top_genres: GenreWeight[];
  deepest_date?: string;
  active_seed_count?: number;
};

type SortType = "composite" | "conviction" | "stickiness" | "listeners";

export default function Home() {
  const [username, setUsername] = useState<string | null>(null);
  const [inputLocal, setInputLocal] = useState("");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [topGenres, setTopGenres] = useState<GenreWeight[]>([]);
  const [deepestDate, setDeepestDate] = useState<string | undefined>(undefined);
  const [activeSeedCount, setActiveSeedCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [sortBy, setSortBy] = useState<SortType>("composite");
  const [isDark, setIsDark] = useState(true);

  // Load persistence and dark mode
  useEffect(() => {
    const saved = localStorage.getItem("obscurity_username");
    if (saved) {
      setUsername(saved);
      setInputLocal(saved);
    }
    const theme = localStorage.getItem("obscurity_theme");
    // Fallback to dark if no saved preference
    if (theme === "light") setIsDark(false);
    else setIsDark(true);
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem("obscurity_theme", "dark");
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem("obscurity_theme", "light");
    }
  }, [isDark]);

  useEffect(() => {
    if (username) {
      localStorage.setItem("obscurity_username", username);
    }
  }, [username]);

  const stickinessThreshold = useMemo(() => {
    if (artists.length < 1) return Infinity;
    const scores = artists.map(a => a.stickiness_score).sort((a, b) => b - a);
    const thresholdIndex = Math.max(0, Math.floor(scores.length * 0.1) - 1);
    return scores[thresholdIndex] || Infinity;
  }, [artists]);

  const sortedArtists = useMemo(() => {
    const arr = [...artists];
    if (sortBy === "composite") arr.sort((a, b) => b.composite_score - a.composite_score);
    else if (sortBy === "conviction") arr.sort((a, b) => b.conviction_score - a.conviction_score);
    else if (sortBy === "stickiness") arr.sort((a, b) => b.stickiness_score - a.stickiness_score);
    else if (sortBy === "listeners") arr.sort((a, b) => b.total_listeners - a.total_listeners);
    return arr;
  }, [artists, sortBy]);

  useEffect(() => {
    const fetchArtists = async () => {
      if (!username) return;
      setLoading(true);
      setWakingUp(false);
      
      const wakeupTimer = setTimeout(() => {
        setWakingUp(true);
      }, 3000);

      try {
        const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
        const response = await fetch(`${apiUrl}/api/discovery?username=${username}&period=overall`);
        if (response.ok) {
          const data: DiscoveryData = await response.json();
          setArtists(data.artists || []);
          setTopGenres(data.top_genres || []);
          setDeepestDate(data.deepest_date);
          setActiveSeedCount(data.active_seed_count || 0);
        }
      } catch (e) {
        console.error("Error fetching data:", e);
      } finally {
        clearTimeout(wakeupTimer);
        setWakingUp(false);
        setLoading(false);
      }
    };
    fetchArtists();
  }, [username]);

  return (
    <div className="flex flex-col items-center w-full px-6 py-20 min-h-screen">
      
      {/* THEME TOGGLE (Solar / Lunar) */}
      <div className="fixed top-8 right-8 z-[110]">
        <button 
          onClick={() => setIsDark(!isDark)}
          className="p-3 bg-white/40 dark:bg-cyan-950/20 border border-neutral-100 dark:border-cyan-500/20 rounded-2xl shadow-sm text-amber-500 dark:text-cyan-400 backdrop-blur-md transition-all duration-700 active:scale-95"
        >
          {isDark ? (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 9h-1m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 5a7 7 0 100 14 7 7 0 000-14z" /></svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
          )}
        </button>
      </div>

      <AnimatePresence mode="wait">
        {!username ? (
          /* LANDING STATE */
          <motion.div 
            key="landing"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, y: -50 }}
            transition={{ duration: 1.2, ease: "easeOut" }}
            className="flex-1 flex flex-col justify-center items-center gap-12 w-full max-w-2xl px-4"
          >
            <div className="flex flex-col items-center gap-4 text-center">
              <h1 className="text-5xl md:text-7xl font-serif dark:font-mono italic dark:not-italic text-neutral-900 dark:text-cyan-50 mb-4 transition-all duration-1000">
                The Obscurity Engine
              </h1>
              <p className="text-[10px] tracking-[0.4em] font-sans dark:font-mono text-emerald-600 dark:text-cyan-400 uppercase font-black transition-all">
                Mapping Sonic Depth via Listening Intensity
              </p>
            </div>

            <form 
              onSubmit={(e) => { e.preventDefault(); if(inputLocal.trim()) setUsername(inputLocal.trim()); }}
              className="w-full flex flex-col gap-8 items-center"
            >
              <div className="w-full relative group">
                <input 
                  autoFocus
                  type="text"
                  value={inputLocal}
                  onChange={(e) => setInputLocal(e.target.value)}
                  placeholder="COMMAND: ENTER LAST.FM USERNAME_"
                  className="w-full bg-transparent border-b-2 border-emerald-500/20 dark:border-cyan-500/30 py-6 text-2xl md:text-4xl font-mono text-neutral-800 dark:text-cyan-400 outline-none focus:border-emerald-500 dark:focus:border-cyan-400 transition-all duration-1000 placeholder:text-neutral-200 dark:placeholder:text-cyan-900 text-center tracking-tight"
                />
              </div>

              <button 
                type="submit"
                disabled={!inputLocal.trim()}
                className="group px-12 py-5 bg-emerald-600 dark:bg-cyan-500 text-white dark:text-black rounded-full dark:rounded-none text-[10px] font-bold dark:font-black tracking-[0.4em] uppercase shadow-2xl hover:bg-emerald-700 dark:hover:bg-cyan-400 transition-all active:scale-95 disabled:opacity-30 flex items-center gap-4"
              >
                Execute Analysis
                <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
              </button>
            </form>
          </motion.div>
        ) : (
          /* DATA HORIZON */
          <motion.div 
            key="discovery"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="w-full flex flex-col items-center"
          >
            {/* Minimalist Sub-Header */}
            <div className="w-full max-w-5xl flex justify-between items-end mb-20 pb-10 border-b border-emerald-500/10 dark:border-cyan-500/10">
               <div onClick={() => setUsername(null)} className="cursor-pointer group flex flex-col gap-1">
                  <h2 className="text-3xl font-serif dark:font-mono italic dark:not-italic text-neutral-900 dark:text-cyan-50 transition-all">Results for {username}</h2>
                  <span className="text-[9px] tracking-widest text-emerald-600/50 dark:text-cyan-500/50 uppercase font-black group-hover:text-emerald-900 dark:group-hover:text-cyan-400 transition-all underline underline-offset-8">Click to reset session</span>
               </div>
            </div>

            <AnimatePresence mode="wait">
              {loading ? (
                <motion.div 
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-12 py-32"
                >
                  <div className="w-48 h-[2px] bg-emerald-500/10 dark:bg-cyan-500/10 rounded-full overflow-hidden relative">
                    <motion.div initial={{ left: "-100%" }} animate={{ left: "100%" }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }} className="absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-emerald-400 dark:via-cyan-400 to-transparent" />
                  </div>
                  
                  <div className="flex flex-col items-center gap-4">
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} key={activeSeedCount} className="text-[10px] tracking-[0.4em] font-sans dark:font-mono text-emerald-600 dark:text-cyan-500 uppercase font-bold text-center max-w-sm leading-loose">
                      {activeSeedCount === 0 ? "Sifting through your recent favorites..." : 
                       activeSeedCount < 50 ? "Finding the quiet voices in your library..." : 
                       "Mapping the subterranean currents..."}
                    </motion.p>
                    
                    {wakingUp && (
                      <p className="text-[9px] tracking-widest text-emerald-500 dark:text-cyan-500 animate-pulse font-mono mt-4">
                        [SYSTEM] WAKING UP ENGINE... ESTABLISHING CONNECTION TO RENDER CLOUD...
                      </p>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div key="results" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.5 }} className="w-full max-w-5xl flex flex-col gap-16">
                  {topGenres.length > 0 && <PortfolioSummary genres={topGenres} seedsAnalyzed={activeSeedCount} totalPool={artists.length} deepestDate={deepestDate} />}
                  {sortedArtists.length > 0 && <ArtistList artists={sortedArtists} sortBy={sortBy} setSortBy={setSortBy} stickinessThreshold={stickinessThreshold} />}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
