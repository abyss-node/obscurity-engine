"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import PortfolioSummary from "../components/PortfolioSummary";
import ArtistList from "../components/ArtistList";
import IcebergVisual from "../components/IcebergVisual";

export type Artist = {
  name: string;
  stickiness_score: number;
  conviction_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { name: string; percentile: number; }[];
  cross_validated?: boolean;
  taste_alignment?: number;
  velocity?: number;
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
  depth_score?: number;
  message?: string;
};

type SortType = "composite" | "conviction" | "stickiness" | "listeners";

const PERIOD_LABELS: Record<string, string> = {
  "7day": "7D", "1month": "1M", "3month": "3M",
  "6month": "6M", "12month": "1Y", "overall": "ALL",
};

export default function Home() {
  const [username, setUsername] = useState<string | null>(null);
  const [inputLocal, setInputLocal] = useState("");
  const [period, setPeriod] = useState("overall");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [topGenres, setTopGenres] = useState<GenreWeight[]>([]);
  const [deepestDate, setDeepestDate] = useState<string | undefined>(undefined);
  const [activeSeedCount, setActiveSeedCount] = useState<number>(0);
  const [depthScore, setDepthScore] = useState<number>(0);
  const [lowDataMessage, setLowDataMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);
  const [sortBy, setSortBy] = useState<SortType>("composite");
  const [isDark, setIsDark] = useState(true);
  const [icebergOpen, setIcebergOpen] = useState(true);
  const [isSharedView, setIsSharedView] = useState(false);
  const [copied, setCopied] = useState(false);

  // Tracks the last username we actually fetched so we can detect username vs period changes
  const lastFetchedUsernameRef = useRef<string | null>(null);

  // D6 + D10: URL params override localStorage on mount; share URLs don't pollute the user's saved session
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlUser = params.get("u");
    const urlPeriod = params.get("p");

    if (urlUser) {
      setUsername(urlUser);
      setInputLocal(urlUser);
      setIsSharedView(true);
      if (urlPeriod && PERIOD_LABELS[urlPeriod]) setPeriod(urlPeriod);
    } else {
      const saved = localStorage.getItem("obscurity_username");
      if (saved) { setUsername(saved); setInputLocal(saved); }
      const savedPeriod = localStorage.getItem("obscurity_period");
      if (savedPeriod) setPeriod(savedPeriod);
    }

    const theme = localStorage.getItem("obscurity_theme");
    if (theme === "light") setIsDark(false);
    else setIsDark(true);
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("obscurity_theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("obscurity_theme", "light");
    }
  }, [isDark]);

  // D6: Don't persist shared-view username/period into the user's own session
  useEffect(() => {
    if (username && !isSharedView) localStorage.setItem("obscurity_username", username);
  }, [username, isSharedView]);

  useEffect(() => {
    if (!isSharedView) localStorage.setItem("obscurity_period", period);
  }, [period, isSharedView]);

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

  // D2: distinguish first load (full spinner) from period refresh (stale results + indicator)
  const isInitialLoad = loading && artists.length === 0;
  const isRefreshing = loading && artists.length > 0;

  useEffect(() => {
    const fetchArtists = async () => {
      if (!username) return;

      // On username switch: clear stale data so we never show wrong user's results
      if (username !== lastFetchedUsernameRef.current) {
        setArtists([]);
        setTopGenres([]);
        setDepthScore(0);
        setLowDataMessage(null);
      }

      setLoading(true);
      setWakingUp(false);
      setError(null);
      lastFetchedUsernameRef.current = username;

      const wakeupTimer = setTimeout(() => setWakingUp(true), 3000);

      try {
        const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
        const response = await fetch(
          `${apiUrl}/api/discovery?username=${encodeURIComponent(username)}&period=${period}`,
          { signal: AbortSignal.timeout(90_000) }
        );

        if (!response.ok) {
          let errMsg = `[ERR] SONAR_FAILURE — HTTP ${response.status}`;
          try {
            const body = await response.json();
            if (body?.error) errMsg = `[ERR] SONAR_FAILURE — ${body.error}`;
          } catch { /* non-JSON error body */ }
          setError(errMsg);
          return;
        }

        const data: DiscoveryData = await response.json();
        setArtists(data.artists || []);
        setTopGenres(data.top_genres || []);
        setDeepestDate(data.deepest_date);
        setActiveSeedCount(data.active_seed_count || 0);
        setDepthScore(data.depth_score ?? 0);
        setLowDataMessage(data.message ?? null);
      } catch (e) {
        const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
        setError(isTimeout
          ? "[ERR] SONAR_FAILURE — Request timed out after 90s. The engine is under heavy load."
          : "[ERR] SONAR_FAILURE — Network error. Check your connection and retry."
        );
        console.error("Fetch error:", e);
      } finally {
        clearTimeout(wakeupTimer);
        setWakingUp(false);
        setLoading(false);
      }
    };

    fetchArtists();
  }, [username, period, fetchTrigger]);

  const handleShare = () => {
    if (!username) return;
    const url = `${window.location.origin}${window.location.pathname}?u=${encodeURIComponent(username)}&p=${period}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleReset = () => {
    setIsSharedView(false);
    setUsername(null);
    setArtists([]);
    setTopGenres([]);
    setDepthScore(0);
    setError(null);
  };

  return (
    <div className="flex flex-col items-center w-full px-6 py-20 min-h-screen">

      {/* THEME TOGGLE */}
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
              onSubmit={(e) => {
                e.preventDefault();
                if (inputLocal.trim()) {
                  setIsSharedView(false);
                  setArtists([]);
                  setTopGenres([]);
                  setUsername(inputLocal.trim());
                }
              }}
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
            {/* Sub-Header: identity + period selector + share */}
            <div className="w-full max-w-5xl flex flex-col gap-5 mb-16 pb-10 border-b border-emerald-500/10 dark:border-cyan-500/10">
              <div className="flex justify-between items-start">
                <div onClick={handleReset} className="cursor-pointer group flex flex-col gap-1">
                  <h2 className="text-3xl font-serif dark:font-mono italic dark:not-italic text-neutral-900 dark:text-cyan-50 transition-all">
                    Results for {username}
                  </h2>
                  <span className="text-[9px] tracking-widest text-emerald-600/50 dark:text-cyan-500/50 uppercase font-black group-hover:text-emerald-900 dark:group-hover:text-cyan-400 transition-all underline underline-offset-8">
                    Click to reset session
                  </span>
                </div>

                {/* 3.6: Share button */}
                <button
                  onClick={handleShare}
                  className="self-start text-[9px] font-mono tracking-[0.3em] uppercase px-5 py-2.5 border border-emerald-500/20 dark:border-cyan-500/20 text-emerald-600/60 dark:text-cyan-500/50 hover:border-emerald-500/60 dark:hover:border-cyan-400/50 hover:text-emerald-700 dark:hover:text-cyan-400 transition-all active:scale-95"
                >
                  {copied ? "COPIED ✓" : "↑ SHARE"}
                </button>
              </div>

              {/* 3.2: Period selector */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[8px] tracking-[0.4em] uppercase font-mono text-emerald-500/30 dark:text-cyan-500/20 mr-1">
                  Period
                </span>
                {Object.entries(PERIOD_LABELS).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setPeriod(val)}
                    className={`text-[9px] font-mono tracking-widest px-3 py-1.5 border transition-all active:scale-95 ${
                      period === val
                        ? "border-emerald-500 dark:border-cyan-400 text-emerald-700 dark:text-cyan-400 bg-emerald-50/50 dark:bg-cyan-950/30"
                        : "border-emerald-500/15 dark:border-cyan-500/15 text-emerald-500/40 dark:text-cyan-500/25 hover:border-emerald-500/40 dark:hover:border-cyan-500/40 hover:text-emerald-600/70 dark:hover:text-cyan-500/60"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {/* D2: inline refresh indicator — stale results stay visible while new ones load */}
                {isRefreshing && (
                  <span className="text-[8px] font-mono tracking-widest uppercase text-cyan-400 dark:text-cyan-400 animate-pulse ml-2">
                    REFRESHING...
                  </span>
                )}
              </div>
            </div>

            <AnimatePresence mode="wait">
              {isInitialLoad ? (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-12 py-32"
                >
                  <div className="w-48 h-[2px] bg-emerald-500/10 dark:bg-cyan-500/10 rounded-full overflow-hidden relative">
                    <motion.div
                      initial={{ left: "-100%" }}
                      animate={{ left: "100%" }}
                      transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                      className="absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-emerald-400 dark:via-cyan-400 to-transparent"
                    />
                  </div>
                  <div className="flex flex-col items-center gap-4">
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-[10px] tracking-[0.4em] font-sans dark:font-mono text-emerald-600 dark:text-cyan-500 uppercase font-bold text-center max-w-sm leading-loose"
                    >
                      Mapping the subterranean currents...
                    </motion.p>
                    {wakingUp && (
                      <p className="text-[9px] tracking-widest text-emerald-500 dark:text-cyan-500 animate-pulse font-mono mt-4">
                        [SYSTEM] WAKING UP ENGINE... ESTABLISHING CONNECTION TO RENDER CLOUD...
                      </p>
                    )}
                  </div>
                </motion.div>
              ) : error && !isRefreshing ? (
                /* ERROR STATE — only shown when we don't have stale results to display */
                <motion.div
                  key="error"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col items-center gap-8 py-32"
                >
                  <p className="text-[11px] tracking-[0.35em] font-mono text-red-500 dark:text-red-400 uppercase text-center max-w-md leading-loose">
                    {error}
                  </p>
                  <button
                    onClick={() => setFetchTrigger(t => t + 1)}
                    className="px-8 py-3 border border-red-500/40 dark:border-red-400/30 text-red-500 dark:text-red-400 text-[9px] tracking-[0.4em] uppercase font-mono hover:bg-red-500/10 transition-all active:scale-95"
                  >
                    Retry Analysis →
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="results"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 1.5 }}
                  className="w-full max-w-5xl flex flex-col gap-16"
                >
                  {/* Low-data warning */}
                  {lowDataMessage && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="w-full border border-amber-500/30 dark:border-yellow-500/20 bg-amber-50/50 dark:bg-yellow-950/20 px-6 py-4"
                    >
                      <p className="text-[10px] tracking-[0.3em] font-mono text-amber-700 dark:text-yellow-400 uppercase leading-loose">
                        [WARN] {lowDataMessage}
                      </p>
                    </motion.div>
                  )}

                  {/* D9: OBSCURITY_INDEX hero — the headline number */}
                  {depthScore > 0 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 }}
                      className="flex flex-col items-center gap-2 py-4"
                    >
                      <span className="text-[8px] tracking-[0.6em] uppercase font-mono text-emerald-500/40 dark:text-cyan-500/30">
                        Obscurity Index
                      </span>
                      <div className="flex items-baseline gap-3">
                        <span className="text-7xl md:text-9xl font-mono font-thin text-emerald-800 dark:text-cyan-300 tabular-nums">
                          {depthScore.toFixed(0)}
                        </span>
                        <span className="text-2xl font-mono text-emerald-400/40 dark:text-cyan-500/30">/ 100</span>
                      </div>
                    </motion.div>
                  )}

                  {topGenres.length > 0 && (
                    <PortfolioSummary
                      genres={topGenres}
                      seedsAnalyzed={activeSeedCount}
                      totalPool={artists.length}
                      deepestDate={deepestDate}
                    />
                  )}

                  {/* Iceberg Visual — collapsible, default open (TASTE #3) */}
                  {sortedArtists.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <button
                        onClick={() => setIcebergOpen(o => !o)}
                        className="self-start text-[9px] tracking-[0.4em] font-mono uppercase text-emerald-600/60 dark:text-cyan-500/60 hover:text-emerald-700 dark:hover:text-cyan-400 transition-all"
                      >
                        {icebergOpen ? "▼ SONAR MAP" : "▶ SONAR MAP"}
                      </button>
                      <AnimatePresence>
                        {icebergOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.4 }}
                            className="overflow-hidden"
                          >
                            <IcebergVisual artists={sortedArtists} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {sortedArtists.length > 0 && (
                    <ArtistList
                      artists={sortedArtists}
                      sortBy={sortBy}
                      setSortBy={setSortBy}
                      stickinessThreshold={stickinessThreshold}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
