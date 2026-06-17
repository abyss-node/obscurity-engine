"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ArtistList from "../components/ArtistList";
import TrackCard from "../components/TrackCard";
import DiscoveryMatrix from "../components/DiscoveryMatrix";
import TracksComingSoon from "../components/TracksComingSoon";
import ApiKeyModal from "../components/ApiKeyModal";
import LoadingState from "../components/LoadingState";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import ShareCard from "../components/ShareCard";
import Tooltip from "../components/Tooltip";
import { isGeoTag, GEO_CANONICAL } from "../lib/geoTags";
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
  reengagement?: boolean;
  user_playcount?: number;
  // Resolved listen/find links (populated by the backend resolver; gated per-artist).
  spotify_url?: string;
  bandcamp_url?: string;
  this_is_url?: string;
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

// Human-readable window phrase for the short-window empty state.
const PERIOD_WINDOWS: Record<string, string> = {
  blend: "your library",
  "7day": "7-day window",
  "1month": "1-month window",
  "3month": "3-month window",
  "6month": "6-month window",
  "12month": "1-year window",
  overall: "all-time",
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
  const [spotifyStatus, setSpotifyStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [focusedArtist, setFocusedArtist] = useState<string | null>(null);

  const lastFetchedUsernameRef = useRef<string | null>(null);
  const forceFreshRef = useRef(false);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [shareState, setShareState] = useState<"idle" | "rendering" | "saved" | "copied">("idle");

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
        (async () => {
          try {
            const token = await Spotify.exchangeCode(code, state);
            if (!token) { setSpotifyStatus("error"); return; }
            const url = await Spotify.createPlaylist(token, storedTracks, meta.username, meta.period);
            Spotify.clearSpotifySession();
            if (url) { setPlaylistUrl(url); setSpotifyStatus("success"); }
            else setSpotifyStatus("error");
          } catch {
            setSpotifyStatus("error");
          }
        })();
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
    // Untagged artists always sink to the end regardless of sort order
    return arr.sort((a, b) => {
      const aUntagged = a.top_tags.length === 0;
      const bUntagged = b.top_tags.length === 0;
      if (aUntagged === bUntagged) return 0;
      return aUntagged ? 1 : -1;
    });
  }, [artists, sortBy]);

  const availableGeoTags = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of sortedArtists) {
      for (const t of a.top_tags) {
        if (isGeoTag(t)) {
          const canonical = GEO_CANONICAL.get(t.toLowerCase()) ?? t.toLowerCase();
          counts[canonical] = (counts[canonical] ?? 0) + 1;
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
      selectedGeoTags.some(sel =>
        a.top_tags.some(t => (GEO_CANONICAL.get(t.toLowerCase()) ?? t.toLowerCase()) === sel)
      )
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
          let detail = `HTTP ${response.status}`;
          try {
            const body = await response.json();
            if (body?.error) detail = String(body.error);
          } catch { /* non-JSON */ }
          // Upstream rate-limit / busy signatures from the backend → actionable hint
          // instead of a raw "error decoding response body".
          const busy =
            response.status >= 500 &&
            /rate limit|error decoding|failed to fetch|temporarily|unavailable/i.test(detail);
          const errMsg = busy
            ? "[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry."
            : response.status >= 500
              ? `[ERR] SONAR_FAILURE — The discovery service hit an error; retry in a moment. (${detail})`
              : `[ERR] SONAR_FAILURE — ${detail}`;
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
            ? "[ERR] SONAR_FAILURE — Request timed out after 90s. The service may be busy; retry."
            : "[ERR] SONAR_FAILURE — Couldn't reach the discovery service. It may be starting up or blocked; retry in a moment."
        );
      } finally {
        clearTimeout(wakeupTimer);
        setWakingUp(false);
        setLoading(false);
      }
    };
    // Tracks discovery is gated behind a "Coming soon" overlay for alpha — don't
    // spend Last.fm rate limit fetching a mode users can't see yet.
    if (mode === "tracks") {
      setLoading(false);
    } else {
      fetchData();
    }
  }, [username, period, mode, fetchTrigger, applyData]);

  const copyShareUrl = () => {
    if (!username) return;
    const url = `${window.location.origin}${window.location.pathname}?u=${encodeURIComponent(username)}&p=${period}&m=${mode}`;
    navigator.clipboard.writeText(url).then(() => {
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 2000);
    });
  };

  // Export the 660×860 result card as a PNG (§8). Falls back to copying the
  // share URL when there's no artist result to render (tracks mode / empty).
  const handleShare = async () => {
    if (!username) return;
    const canExport =
      mode === "artists" && artists.length > 0 && depthScore > 0 && shareCardRef.current;
    if (!canExport) {
      copyShareUrl();
      return;
    }
    try {
      setShareState("rendering");
      const { toPng } = await import("html-to-image");
      // Wait for the self-hosted web fonts so Playfair/Plex render in the snapshot.
      await document.fonts.ready;
      const node = shareCardRef.current!;
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#080806",
        width: node.offsetWidth,
        height: node.offsetHeight,
        cacheBust: true,
      });
      const link = document.createElement("a");
      link.download = `obscurity-${username}-${period}.png`;
      link.href = dataUrl;
      link.click();
      setShareState("saved");
      setTimeout(() => setShareState("idle"), 2000);
    } catch (e) {
      console.error("Share card export failed:", e);
      setShareState("idle");
      copyShareUrl(); // never leave the button dead — copy the URL instead
    }
  };

  const handleRetry = () => {
    forceFreshRef.current = true;
    setFetchTrigger((t) => t + 1);
  };

  const handleSaveApiKey = (key: string) => {
    setApiKey(key);
    setApiKeyInput(key);
    if (key) localStorage.setItem("obscurity_api_key", key);
    else localStorage.removeItem("obscurity_api_key");
    setShowApiKey(false);
  };

  // Fresh-account empty state: drop back to the landing page with the setup
  // guide already open so a new user can fix scrobbling without hunting for it.
  const handleCheckSetup = () => {
    handleReset();
    setShowSetup(true);
    setShowApiKey(false);
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
      {/* Fixed wordmark. On mobile it's hidden in the results view (the top bar
          needs that space); the landing view keeps it. Always shown ≥720px. */}
      <div
        className={`fixed top-0 left-0 z-50 px-6 h-12 items-center pointer-events-none ${
          username ? "hidden min-[720px]:flex" : "flex"
        }`}
      >
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
            className="min-h-screen flex items-start justify-center px-6 py-[15vh]"
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
                    onClick={() => { setShowSetup((s) => !s); setShowApiKey(false); }}
                    className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                    style={{ color: "var(--dim)" }}
                  >
                    connect your music {showSetup ? "▲" : "▼"}
                  </button>
                  <span className="font-mono text-[10px]" style={{ color: "var(--border)" }}>|</span>
                  <button
                    onClick={() => { setShowApiKey((s) => !s); setShowSetup(false); }}
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
                        <p className="font-mono text-[10px] tracking-wider leading-relaxed" style={{ color: "var(--muted)" }}>
                          your own key avoids shared rate limits — saved to this browser permanently
                        </p>
                        <ol className="flex flex-col gap-1.5">
                          {[
                            <>go to <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener noreferrer" className="transition-opacity hover:opacity-60" style={{ color: "var(--accent)" }}>last.fm/api/account/create</a></>,
                            <>application name: anything (e.g. <span style={{ color: "var(--muted)" }}>my music tool</span>)</>,
                            <>description: anything (e.g. <span style={{ color: "var(--muted)" }}>personal use</span>)</>,
                            <>callback url: <span style={{ color: "var(--muted)" }}>leave blank</span></>,
                            <>submit → copy the 32-character api key</>,
                          ].map((step, i) => (
                            <li key={i} className="flex gap-2 font-mono text-[10px] tracking-wider leading-relaxed" style={{ color: "var(--dim)" }}>
                              <span style={{ color: "var(--border)" }}>{i + 1}.</span>
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
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
              className="fixed top-0 left-0 right-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b min-[720px]:flex-nowrap min-[720px]:h-12 min-[720px]:py-0 min-[720px]:px-6 min-[720px]:gap-4"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            >
              {/* Wordmark spacer (desktop only — the floating wordmark is hidden on mobile) */}
              <div className="w-40 shrink-0 hidden min-[720px]:block" />

              <span className="font-mono text-xs shrink-0 hidden min-[720px]:inline" style={{ color: "var(--border)" }}>
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

              <span className="font-mono text-xs shrink-0 hidden min-[720px]:inline" style={{ color: "var(--border)" }}>
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

              <span className="font-mono text-xs shrink-0 hidden min-[720px]:inline" style={{ color: "var(--border)" }}>|</span>

              {/* Period pills — own full-width row on mobile, inline on desktop */}
              <div className="flex flex-wrap gap-1 order-last basis-full min-[720px]:order-none min-[720px]:basis-auto min-[720px]:flex-1 min-[720px]:min-w-0">
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
              </div>

              {/* Refresh */}
              <button
                onClick={handleRetry}
                disabled={loading}
                className="font-mono text-[10px] tracking-widest shrink-0 transition-opacity duration-150 hover:opacity-60 disabled:opacity-30"
                style={{ color: "var(--dim)" }}
              >
                {isRefreshing ? "..." : "↺ refresh"}
              </button>

              <span className="font-mono text-xs shrink-0 hidden min-[720px]:inline" style={{ color: "var(--border)" }}>|</span>

              {/* Share */}
              <button
                onClick={handleShare}
                disabled={shareState === "rendering"}
                className="font-mono text-[10px] tracking-widest shrink-0 transition-opacity duration-150 hover:opacity-60 disabled:opacity-40"
                style={{ color: "var(--dim)" }}
              >
                {shareState === "rendering"
                  ? "rendering…"
                  : shareState === "saved"
                    ? "saved ✓"
                    : shareState === "copied"
                      ? "copied"
                      : "↑ share"}
              </button>
            </div>

            {/* Scrollable content (extra top pad on mobile clears the 2-row bar) */}
            <div className="pt-[68px] min-[720px]:pt-12 min-h-screen">
              <AnimatePresence mode="wait">
                {isInitialLoad ? (
                  <LoadingState wakingUp={wakingUp} />
                ) : error && !isRefreshing ? (
                  <ErrorState
                    error={error}
                    onRetry={handleRetry}
                    onAddApiKey={() => setShowApiKey(true)}
                  />
                ) : (
                  /* ── RESULTS ──────────────────────────────────────── */
                  <div className="max-w-4xl mx-auto px-4 sm:px-8 py-16 flex flex-col gap-16">
                    {mode === "artists" && lowDataMessage && sortedArtists.length > 0 && (
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

                    {/* Empty states (§8) — no artists came back. Distinguish a
                        fresh 0-scrobble account (activeSeedCount === 0) from a
                        short period window that simply had no signal. */}
                    {mode === "artists" && !error && sortedArtists.length === 0 && (
                      <EmptyState
                        variant={activeSeedCount === 0 ? "fresh" : "short-window"}
                        windowLabel={PERIOD_WINDOWS[period] ?? "this window"}
                        onCheckSetup={handleCheckSetup}
                        onCheckAgain={handleRetry}
                      />
                    )}

                    {/* Depth Assessment */}
                    {mode === "artists" && depthScore > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.6 }}
                        className="flex flex-col gap-3 pb-8 border-b"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <Tooltip text="0–100. Measures how far below the mainstream your results sit. Weighted by how strongly each artist was recommended — not just a simple average.">
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
                        <Tooltip text="Seeds: artists pulled from your listening history to drive the search. Candidates: the final count after scoring, filtering, and diversity enforcement.">
                          <p
                            className="font-mono text-[10px] tracking-wider"
                            style={{ color: "var(--dim)" }}
                          >
                            {activeSeedCount} seeds · {artists.length} candidates
                          </p>
                        </Tooltip>
                      </motion.div>
                    )}

                    {/* Discovery Matrix */}
                    {mode === "artists" && sortedArtists.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.2, duration: 0.6 }}
                        className="flex flex-col gap-3"
                      >
                        <div className="flex items-baseline gap-3 flex-wrap">
                          <Tooltip text="Two axes that decide what you actually play: conviction (how strongly your seeds point here) on X, stickiness (how dedicated the fanbase is) on Y. Obscurity rides along as dot size — bigger = deeper cut.">
                            <button
                              onClick={() => setIcebergOpen((o) => !o)}
                              className="font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-60"
                              style={{ color: "var(--dim)" }}
                            >
                              {icebergOpen ? "▼" : "▶"} discovery matrix
                            </button>
                          </Tooltip>
                          <span className="font-mono text-[9px] tracking-wider" style={{ color: "var(--dim)", opacity: 0.7 }}>
                            conviction × stickiness · dot size = obscurity
                          </span>
                        </div>
                        <AnimatePresence>
                          {icebergOpen && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.35 }}
                              className="overflow-hidden"
                            >
                              <DiscoveryMatrix
                                artists={sortedArtists}
                                onArtistClick={(name) => {
                                  setFocusedArtist(null);
                                  setTimeout(() => setFocusedArtist(name), 0);
                                }}
                              />
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
                          focusedArtist={focusedArtist}
                        />
                      </motion.div>
                    )}

                    {/* Tracks — gated behind a "Coming soon" overlay for alpha (§6) */}
                    {mode === "tracks" && (
                      <TracksComingSoon onBack={() => setMode("artists")} />
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
                              spotify export failed —{" "}
                              <button
                                onClick={() => setSpotifyStatus("idle")}
                                className="transition-opacity hover:opacity-60"
                                style={{ color: "var(--accent)" }}
                              >
                                try again
                              </button>
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

            {/* API-key modal — rate-limit escape hatch (§8) */}
            <AnimatePresence>
              {showApiKey && (
                <ApiKeyModal
                  initialValue={apiKey}
                  onSave={handleSaveApiKey}
                  onClose={() => setShowApiKey(false)}
                />
              )}
            </AnimatePresence>

            {/* Off-screen 660×860 result card — the snapshot source for the
                top-bar "↑ share" PNG export (§8). Kept in the DOM (not display:none)
                so html-to-image can measure and render it; pushed off-screen and
                made non-interactive so it never affects layout or focus. */}
            {mode === "artists" && artists.length > 0 && depthScore > 0 && (
              <div
                aria-hidden
                style={{ position: "fixed", left: -9999, top: 0, pointerEvents: "none", opacity: 0 }}
              >
                <ShareCard
                  ref={shareCardRef}
                  username={username}
                  depthScore={depthScore}
                  verdict={depthProse ?? ""}
                  artists={sortedArtists}
                  topGenres={topGenres}
                  activeSeedCount={activeSeedCount}
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
