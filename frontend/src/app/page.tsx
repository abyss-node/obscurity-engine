"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ArtistList from "../components/ArtistList";
import TrackCard from "../components/TrackCard";
import IcebergVisual from "../components/IcebergVisual";
import LoadingState from "../components/LoadingState";
import ErrorState from "../components/ErrorState";
import Tooltip from "../components/Tooltip";
import { isGeoTag } from "../lib/geoTags";
import { getDepthProse } from "../lib/scoring";
import * as Spotify from "../lib/spotify";
import { loadCache, saveCache } from "../lib/cache";
import OnboardingGuide from "../components/OnboardingGuide";

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

export type TrackItem = {
  name: string;
  artist: string;
  conviction_score: number;
  stickiness_score: number;
  composite_score: number;
  total_listeners: number;
  top_tags: string[];
  source_seeds: { track: string; artist: string; percentile: number }[];
  taste_alignment: number;
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

export type TrackDiscoveryData = {
  tracks: TrackItem[];
  top_genres: GenreWeight[];
  active_seed_count: number;
  depth_score: number;
  message?: string;
};

type SortType = "composite" | "conviction" | "stickiness" | "listeners";
type DiscoveryMode = "artists" | "tracks";

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
  const [mode, setMode] = useState<DiscoveryMode>("artists");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [tracks, setTracks] = useState<TrackItem[]>([]);
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
  const [spotifyStatus, setSpotifyStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKey, setApiKey] = useState("");

  const lastFetchedUsernameRef = useRef<string | null>(null);
  const forceFreshRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    // Handle Spotify OAuth callback
    if (code && state) {
      window.history.replaceState({}, "", window.location.pathname);
      const storedTracks = Spotify.getStoredTracks();
      const meta = Spotify.getStoredMeta();
      if (storedTracks && meta) {
        setUsername(meta.username);
        setInputLocal(meta.username);
        setMode("tracks");
        setTracks(storedTracks);
        setSpotifyStatus("loading");
        Spotify.exchangeCode(code, state).then((token) => {
          if (!token) { setSpotifyStatus("error"); return; }
          return Spotify.createPlaylist(token, storedTracks, meta.username, meta.period);
        }).then((url) => {
          Spotify.clearSpotifySession();
          if (url) { setPlaylistUrl(url); setSpotifyStatus("success"); }
          else setSpotifyStatus("error");
        }).catch(() => setSpotifyStatus("error"));
      }
      return;
    }

    const urlUser = params.get("u");
    const urlPeriod = params.get("p");
    const urlMode = params.get("m");
    if (urlUser) {
      setUsername(urlUser);
      setInputLocal(urlUser);
      setIsSharedView(true);
      if (urlPeriod && PERIOD_LABELS[urlPeriod]) setPeriod(urlPeriod);
      if (urlMode === "tracks" || urlMode === "artists") setMode(urlMode as DiscoveryMode);
    } else {
      const saved = localStorage.getItem("obscurity_username");
      if (saved) setInputLocal(saved); // pre-fill input but don't auto-fetch; user submits
      const savedPeriod = localStorage.getItem("obscurity_period");
      if (savedPeriod && PERIOD_LABELS[savedPeriod]) setPeriod(savedPeriod);
      const savedKey = localStorage.getItem("obscurity_api_key");
      if (savedKey) { setApiKey(savedKey); setApiKeyInput(savedKey); }
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

  const resultCount = mode === "tracks" ? tracks.length : artists.length;
  const isInitialLoad = loading && resultCount === 0;
  const isRefreshing = loading && resultCount > 0;

  const applyData = useCallback((data: DiscoveryData | TrackDiscoveryData, m: DiscoveryMode) => {
    if (m === "tracks") {
      const d = data as TrackDiscoveryData;
      setTracks(d.tracks || []);
      setTopGenres(d.top_genres || []);
      setActiveSeedCount(d.active_seed_count || 0);
      setDepthScore(d.depth_score ?? 0);
      setLowDataMessage(d.message ?? null);
    } else {
      const d = data as DiscoveryData;
      setArtists(d.artists || []);
      setTopGenres(d.top_genres || []);
      setActiveSeedCount(d.active_seed_count || 0);
      setDepthScore(d.depth_score ?? 0);
      setLowDataMessage(d.message ?? null);
    }
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      if (!username) return;

      const isForceFresh = forceFreshRef.current;
      forceFreshRef.current = false;

      setError(null);
      setLowDataMessage(null);
      setSelectedGeoTags([]);
      lastFetchedUsernameRef.current = username;

      // Serve from cache when fresh and not a forced retry
      if (!isForceFresh) {
        const cached = loadCache<DiscoveryData | TrackDiscoveryData>(username, period, mode);
        if (cached) {
          if (mode === "tracks") setArtists([]);
          else setTracks([]);
          applyData(cached, mode);
          setLoading(false);
          return;
        }
      }

      setArtists([]);
      setTracks([]);
      setTopGenres([]);
      setDepthScore(0);
      setLoading(true);
      setWakingUp(false);
      const wakeupTimer = setTimeout(() => setWakingUp(true), 3000);
      try {
        const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
        const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
        const endpoint = mode === "tracks"
          ? `${apiUrl}/api/discovery/tracks?username=${encodeURIComponent(username)}&period=${period}${keyParam}`
          : `${apiUrl}/api/discovery?username=${encodeURIComponent(username)}&period=${period}${keyParam}`;
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
        if (!response.ok) {
          let errMsg = `[ERR] SONAR_FAILURE — HTTP ${response.status}`;
          try {
            const body = await response.json();
            if (body?.error) errMsg = `[ERR] SONAR_FAILURE — ${body.error}`;
          } catch { /* non-JSON */ }
          setError(errMsg);
          return;
        }
        if (mode === "tracks") {
          const data: TrackDiscoveryData = await response.json();
          applyData(data, mode);
          saveCache(username, period, mode, data);
        } else {
          const data: DiscoveryData = await response.json();
          applyData(data, mode);
          saveCache(username, period, mode, data);
        }
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
    fetchData();
  }, [username, period, mode, fetchTrigger, applyData]);

  const handleShare = () => {
    if (!username) return;
    const url = `${window.location.origin}${window.location.pathname}?u=${encodeURIComponent(username)}&p=${period}&m=${mode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRetry = () => {
    forceFreshRef.current = true;
    setFetchTrigger((t) => t + 1);
  };

  const handleReset = () => {
    setIsSharedView(false);
    setUsername(null);
    setArtists([]);
    setTracks([]);
    setTopGenres([]);
    setDepthScore(0);
    setError(null);
    setSpotifyStatus("idle");
    setPlaylistUrl(null);
  };

  const handleExportSpotify = async () => {
    if (!username || tracks.length === 0) return;
    if (!Spotify.isConfigured()) {
      alert("Spotify export is not configured. Set NEXT_PUBLIC_SPOTIFY_CLIENT_ID.");
      return;
    }
    await Spotify.initiateSpotifyAuth(tracks, username, period);
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
            <div className="w-full max-w-md flex flex-col items-center gap-8">
              {/* Headline */}
              <div className="flex flex-col items-center gap-3 text-center">
                <h1
                  className="font-serif text-4xl md:text-5xl font-bold italic leading-tight"
                  style={{ color: "var(--text)" }}
                >
                  Find your new<br />favorite artist.
                </h1>
                <p
                  className="font-body text-sm font-light max-w-xs leading-relaxed"
                  style={{ color: "var(--muted)" }}
                >
                  Connects to your Last.fm history. Surfaces artists and tracks
                  that match your taste but haven&apos;t broken through yet.
                </p>
              </div>

              {/* Input */}
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
                className="w-full flex flex-col items-center gap-6"
              >
                <input
                  autoFocus
                  type="text"
                  value={inputLocal}
                  onChange={(e) => setInputLocal(e.target.value)}
                  placeholder="last.fm username"
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

              {/* Onboarding links */}
              <div className="w-full flex flex-col items-center gap-5">
                <div className="flex items-center gap-4">
                  <a
                    href="https://www.last.fm/join"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                    style={{ color: "var(--accent)" }}
                  >
                    new to last.fm? create account →
                  </a>
                  <span className="font-mono text-[10px]" style={{ color: "var(--border)" }}>|</span>
                  <button
                    onClick={() => setShowSetup((s) => !s)}
                    className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                    style={{ color: "var(--dim)" }}
                  >
                    connect your music {showSetup ? "▲" : "▼"}
                  </button>
                  <span className="font-mono text-[10px]" style={{ color: "var(--border)" }}>|</span>
                  <button
                    onClick={() => setShowApiKey((s) => !s)}
                    className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                    style={{ color: apiKey ? "var(--accent)" : "var(--dim)" }}
                  >
                    {apiKey ? "api key active ▼" : `api key ${showApiKey ? "▲" : "▼"}`}
                  </button>
                </div>

                <AnimatePresence>
                  {showSetup && (
                    <motion.div
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.25 }}
                      className="w-full"
                    >
                      <OnboardingGuide />
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {showApiKey && (
                    <motion.div
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.25 }}
                      className="w-full flex flex-col gap-3"
                    >
                      <div className="border p-4 flex flex-col gap-3" style={{ borderColor: "var(--border)" }}>
                        <p className="font-mono text-[10px] tracking-wider leading-relaxed" style={{ color: "var(--dim)" }}>
                          Use your own Last.fm API key to avoid shared rate limits.{" "}
                          <a
                            href="https://www.last.fm/api/account/create"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transition-opacity hover:opacity-60"
                            style={{ color: "var(--accent)" }}
                          >
                            get a free key →
                          </a>
                        </p>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={apiKeyInput}
                            onChange={(e) => setApiKeyInput(e.target.value)}
                            placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                            className="flex-1 bg-transparent border-b py-1 font-mono text-[11px] outline-none transition-colors duration-200"
                            style={{ borderColor: "var(--border)", color: "var(--text)", caretColor: "var(--accent)" }}
                          />
                          <button
                            onClick={() => {
                              const trimmed = apiKeyInput.trim();
                              setApiKey(trimmed);
                              if (trimmed) localStorage.setItem("obscurity_api_key", trimmed);
                              else localStorage.removeItem("obscurity_api_key");
                              setShowApiKey(false);
                            }}
                            className="font-mono text-[10px] tracking-widest transition-opacity hover:opacity-60 shrink-0"
                            style={{ color: "var(--muted)" }}
                          >
                            {apiKeyInput.trim() ? "save" : "clear"}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
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

              {/* Mode toggle */}
              <div className="flex gap-1 shrink-0">
                {(["artists", "tracks"] as DiscoveryMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className="font-mono text-[10px] tracking-wider px-2 py-0.5 border transition-colors duration-150"
                    style={{
                      borderColor: mode === m ? "var(--accent)" : "var(--border)",
                      color: mode === m ? "var(--accent)" : "var(--dim)",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <span className="font-mono text-xs shrink-0" style={{ color: "var(--border)" }}>|</span>

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
                    onRetry={handleRetry}
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
                            {activeSeedCount} seeds · {mode === "tracks" ? tracks.length : artists.length} candidates
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
                        <Tooltip text="Artists grouped by listener depth: SURFACE (10K+), MID (3K–10K), DEEP (500–3K), ABYSS (<500). Lower tier = more underground.">
                          <button
                            onClick={() => setIcebergOpen((o) => !o)}
                            className="self-start font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-60"
                            style={{ color: "var(--dim)" }}
                          >
                            {icebergOpen ? "▼" : "▶"} depth map
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
                    {mode === "artists" && sortedArtists.length > 0 && (
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

                    {/* Track empty state */}
                    {mode === "tracks" && tracks.length === 0 && !loading && !error && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.5 }}
                        className="flex flex-col gap-4 py-16 items-center text-center"
                      >
                        <span
                          className="font-mono text-[10px] tracking-widest uppercase"
                          style={{ color: "var(--dim)" }}
                        >
                          [SONAR] no signal
                        </span>
                        <p className="font-body text-lg font-light" style={{ color: "var(--muted)" }}>
                          No obscure tracks found for this period.
                        </p>
                        <p className="font-mono text-[10px] tracking-wider max-w-xs" style={{ color: "var(--dim)" }}>
                          Try a longer time window — MIX or ALL give the most seeds to work from.
                        </p>
                      </motion.div>
                    )}

                    {/* Track List */}
                    {mode === "tracks" && tracks.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.4, duration: 0.6 }}
                        className="flex flex-col gap-6"
                      >
                        {/* Spotify playlist */}
                        <div className="flex items-center gap-4">
                          {spotifyStatus === "idle" && (
                            <button
                              onClick={handleExportSpotify}
                              className="font-mono text-[10px] tracking-widest border px-4 py-2 transition-opacity duration-150 hover:opacity-70 flex items-center gap-2"
                              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                            >
                              <span style={{ color: "#1DB954" }}>♫</span> add to spotify
                            </button>
                          )}
                          {spotifyStatus === "loading" && (
                            <span className="font-mono text-[10px] tracking-widest animate-pulse" style={{ color: "var(--dim)" }}>
                              creating playlist...
                            </span>
                          )}
                          {spotifyStatus === "success" && playlistUrl && (
                            <a
                              href={playlistUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-[10px] tracking-widest border px-4 py-2 transition-opacity duration-150 hover:opacity-70 flex items-center gap-2"
                              style={{ borderColor: "#1DB954", color: "#1DB954" }}
                            >
                              <span>♫</span> open playlist ↗
                            </a>
                          )}
                          {spotifyStatus === "error" && (
                            <span className="font-mono text-[10px] tracking-widest" style={{ color: "var(--muted)" }}>
                              spotify export failed — try again
                            </span>
                          )}
                        </div>

                        <TrackCard key={`${tracks[0].name}-hero`} track={tracks[0]} rank={1} isHero />
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {tracks.slice(1).map((track, idx) => (
                            <TrackCard key={`${track.name}-${track.artist}-${idx}`} track={track} rank={idx + 2} />
                          ))}
                        </div>
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
