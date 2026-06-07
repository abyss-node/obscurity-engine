"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ArtistList from "../components/ArtistList";
import IcebergVisual from "../components/IcebergVisual";
import LoadingState from "../components/LoadingState";
import ErrorState from "../components/ErrorState";
import Tooltip from "../components/Tooltip";
import { isGeoTag } from "../lib/geoTags";
import { getDepthProse } from "../lib/scoring";

export type Artist = {
  name: string;
  stickiness_score: number;
  conviction_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { name: string; percentile: number }[];
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
  blend: "MIX",
  "7day": "7D",
  "1month": "1M",
  "3month": "3M",
  "6month": "6M",
  "12month": "1Y",
  overall: "ALL",
};

export default function Home() {
  const [username, setUsername] = useState<string | null>(null);
  const [inputLocal, setInputLocal] = useState("");
  const [period, setPeriod] = useState("blend");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [topGenres, setTopGenres] = useState<GenreWeight[]>([]);
  const [activeSeedCount, setActiveSeedCount] = useState(0);
  const [depthScore, setDepthScore] = useState(0);
  const [lowDataMessage, setLowDataMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);
  const [sortBy, setSortBy] = useState<SortType>("composite");
  const [selectedGeoTags, setSelectedGeoTags] = useState<string[]>([]);
  const [icebergOpen, setIcebergOpen] = useState(true);
  const [isSharedView, setIsSharedView] = useState(false);
  const [copied, setCopied] = useState(false);

  const lastFetchedUsernameRef = useRef<string | null>(null);

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
      if (savedPeriod && PERIOD_LABELS[savedPeriod]) setPeriod(savedPeriod);
    }
  }, []);

  useEffect(() => {
    if (username && !isSharedView) localStorage.setItem("obscurity_username", username);
  }, [username, isSharedView]);

  useEffect(() => {
    if (!isSharedView) localStorage.setItem("obscurity_period", period);
  }, [period, isSharedView]);

  const stickinessThreshold = useMemo(() => {
    if (artists.length < 1) return Infinity;
    const scores = artists.map((a) => a.stickiness_score).sort((a, b) => b - a);
    return scores[Math.max(0, Math.floor(scores.length * 0.1) - 1)] ?? Infinity;
  }, [artists]);

  const sortedArtists = useMemo(() => {
    const arr = [...artists];
    if (sortBy === "composite") arr.sort((a, b) => b.composite_score - a.composite_score);
    else if (sortBy === "conviction") arr.sort((a, b) => b.conviction_score - a.conviction_score);
    else if (sortBy === "stickiness") arr.sort((a, b) => b.stickiness_score - a.stickiness_score);
    else if (sortBy === "listeners") arr.sort((a, b) => b.total_listeners - a.total_listeners);
    return arr;
  }, [artists, sortBy]);

  const availableGeoTags = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of sortedArtists) {
      for (const t of a.top_tags) {
        if (isGeoTag(t)) {
          const key = t.toLowerCase();
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
  }, [sortedArtists]);

  const filteredArtists = useMemo(() => {
    if (selectedGeoTags.length === 0) return sortedArtists;
    return sortedArtists.filter(a =>
      selectedGeoTags.every(sel => a.top_tags.some(t => t.toLowerCase() === sel))
    );
  }, [sortedArtists, selectedGeoTags]);

  const isInitialLoad = loading && artists.length === 0;
  const isRefreshing = loading && artists.length > 0;

  useEffect(() => {
    const fetchArtists = async () => {
      if (!username) return;
      if (username !== lastFetchedUsernameRef.current) {
        setArtists([]);
        setTopGenres([]);
        setDepthScore(0);
        setLowDataMessage(null);
        setSelectedGeoTags([]);
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
          } catch { /* non-JSON */ }
          setError(errMsg);
          return;
        }
        const data: DiscoveryData = await response.json();
        setArtists(data.artists || []);
        setTopGenres(data.top_genres || []);
        setActiveSeedCount(data.active_seed_count || 0);
        setDepthScore(data.depth_score ?? 0);
        setLowDataMessage(data.message ?? null);
      } catch (e) {
        const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
        setError(
          isTimeout
            ? "[ERR] SONAR_FAILURE — Request timed out after 90s."
            : "[ERR] SONAR_FAILURE — Network error. Check your connection."
        );
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

  const depthProse =
    depthScore > 0
      ? getDepthProse(
          depthScore,
          topGenres[0]?.weight > 10 ? topGenres[0]?.name : undefined
        )
      : null;

  return (
    <>
      {/* Fixed wordmark */}
      <div className="fixed top-0 left-0 z-50 px-6 h-12 flex items-center pointer-events-none">
        <span
          className="font-serif text-[13px] font-semibold tracking-wide cursor-pointer pointer-events-auto transition-opacity duration-200 hover:opacity-70"
          style={{ color: "var(--accent)" }}
          onClick={handleReset}
        >
          OBSCURITY ENGINE
        </span>
      </div>

      <AnimatePresence mode="wait">
        {!username ? (
          /* ── LANDING ─────────────────────────────────────────────── */
          <motion.div
            key="landing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.35 }}
            className="min-h-screen flex items-center justify-center px-6"
          >
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
              className="w-full max-w-md flex flex-col items-center gap-8"
            >
              <input
                autoFocus
                type="text"
                value={inputLocal}
                onChange={(e) => setInputLocal(e.target.value)}
                placeholder="enter last.fm username"
                className="obs-input w-full bg-transparent border-b-2 py-3 text-2xl font-mono outline-none text-center transition-colors duration-200"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text)",
                  caretColor: "var(--accent)",
                }}
              />
              <AnimatePresence>
                {inputLocal.trim() && (
                  <motion.button
                    type="submit"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="font-mono text-[11px] tracking-widest transition-opacity duration-200 hover:opacity-60"
                    style={{ color: "var(--muted)" }}
                  >
                    analyse →
                  </motion.button>
                )}
              </AnimatePresence>
            </form>
          </motion.div>
        ) : (
          /* ── RESULTS VIEW ────────────────────────────────────────── */
          <motion.div
            key="results-shell"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            {/* Fixed top bar */}
            <div
              className="fixed top-0 left-0 right-0 z-40 h-12 flex items-center px-6 gap-4 border-b"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            >
              {/* Wordmark spacer */}
              <div className="w-40 shrink-0" />

              <span className="font-mono text-xs shrink-0" style={{ color: "var(--border)" }}>
                |
              </span>

              {/* Username */}
              <button
                onClick={handleReset}
                className="font-mono text-[11px] tracking-wide transition-opacity duration-150 hover:opacity-50 shrink-0"
                style={{ color: "var(--muted)" }}
              >
                {username}
              </button>

              <span className="font-mono text-xs shrink-0" style={{ color: "var(--border)" }}>
                |
              </span>

              {/* Period pills */}
              <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                {Object.entries(PERIOD_LABELS).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setPeriod(val)}
                    className="font-mono text-[10px] tracking-wider px-2 py-0.5 border transition-colors duration-150"
                    style={{
                      borderColor: period === val ? "var(--accent)" : "var(--border)",
                      color: period === val ? "var(--accent)" : "var(--dim)",
                    }}
                  >
                    {label}
                  </button>
                ))}
                {isRefreshing && (
                  <span
                    className="font-mono text-[9px] tracking-widest animate-pulse self-center ml-1"
                    style={{ color: "var(--dim)" }}
                  >
                    ...
                  </span>
                )}
              </div>

              {/* Share */}
              <button
                onClick={handleShare}
                className="font-mono text-[10px] tracking-widest shrink-0 transition-opacity duration-150 hover:opacity-60"
                style={{ color: "var(--dim)" }}
              >
                {copied ? "copied" : "↑ share"}
              </button>
            </div>

            {/* Scrollable content */}
            <div className="pt-12 min-h-screen">
              <AnimatePresence mode="wait">
                {isInitialLoad ? (
                  <LoadingState wakingUp={wakingUp} />
                ) : error && !isRefreshing ? (
                  <ErrorState
                    error={error}
                    onRetry={() => setFetchTrigger((t) => t + 1)}
                  />
                ) : (
                  /* ── RESULTS ──────────────────────────────────────── */
                  <div className="max-w-4xl mx-auto px-4 sm:px-8 py-16 flex flex-col gap-16">
                    {lowDataMessage && (
                      <div
                        className="border px-5 py-3"
                        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                      >
                        <p
                          className="font-mono text-[10px] tracking-wider leading-loose"
                          style={{ color: "var(--muted)" }}
                        >
                          [WARN] {lowDataMessage}
                        </p>
                      </div>
                    )}

                    {/* Depth Assessment */}
                    {depthScore > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.6 }}
                        className="flex flex-col gap-3 pb-8 border-b"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <Tooltip text="A score from 0–100. Higher means your taste skews toward artists with small but dedicated fanbases — the deeper the cut, the higher the score.">
                          <span
                            className="font-mono text-[10px] tracking-widest uppercase"
                            style={{ color: "var(--dim)" }}
                          >
                            obscurity index
                          </span>
                        </Tooltip>
                        <div className="flex items-baseline gap-3">
                          <span
                            className="font-serif text-7xl sm:text-8xl font-bold italic leading-none"
                            style={{ color: "var(--accent)" }}
                          >
                            {depthScore.toFixed(0)}
                          </span>
                          <span className="font-mono text-sm" style={{ color: "var(--dim)" }}>
                            / 100
                          </span>
                        </div>
                        {depthProse && (
                          <p
                            className="font-body text-lg font-light italic"
                            style={{ color: "var(--muted)" }}
                          >
                            {depthProse}
                          </p>
                        )}
                        <Tooltip text="Seeds are artists from your listening history used to find recommendations. Candidates are all similar artists evaluated before filtering.">
                          <p
                            className="font-mono text-[10px] tracking-wider"
                            style={{ color: "var(--dim)" }}
                          >
                            {activeSeedCount} seeds · {artists.length} candidates
                          </p>
                        </Tooltip>
                      </motion.div>
                    )}

                    {/* Sonar Map */}
                    {sortedArtists.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.2, duration: 0.6 }}
                        className="flex flex-col gap-3"
                      >
                        <Tooltip text="Artists plotted by obscurity depth. Higher up = more mainstream (more listeners). Lower = deeper cuts. Hover a dot to see the artist.">
                          <button
                            onClick={() => setIcebergOpen((o) => !o)}
                            className="self-start font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-60"
                            style={{ color: "var(--dim)" }}
                          >
                            {icebergOpen ? "▼" : "▶"} sonar map
                          </button>
                        </Tooltip>
                        <AnimatePresence>
                          {icebergOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.35 }}
                              className="overflow-hidden"
                            >
                              <IcebergVisual artists={sortedArtists} />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}

                    {/* Artist List */}
                    {sortedArtists.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.4, duration: 0.6 }}
                      >
                        <ArtistList
                          artists={filteredArtists}
                          sortBy={sortBy}
                          setSortBy={(val) => setSortBy(val as SortType)}
                          stickinessThreshold={stickinessThreshold}
                          availableGeoTags={availableGeoTags}
                          selectedGeoTags={selectedGeoTags}
                          setSelectedGeoTags={setSelectedGeoTags}
                        />
                      </motion.div>
                    )}
                  </div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
