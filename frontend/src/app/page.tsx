"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import TrackCard from "../components/TrackCard";
import ResultsTopBar from "../components/ResultsTopBar";
import ResultsBody from "../components/ResultsBody";
import TracksComingSoon from "../components/TracksComingSoon";
import ApiKeyModal from "../components/ApiKeyModal";
import LoadingState from "../components/LoadingState";
import ErrorState from "../components/ErrorState";
import EmptyState from "../components/EmptyState";
import ShareCard from "../components/ShareCard";
import { isGeoTag, GEO_CANONICAL } from "../lib/geoTags";
import { getDepthProse } from "../lib/scoring";
import * as Spotify from "../lib/spotify";
import { loadCache, saveCache } from "../lib/cache";
import type { SharePayload } from "../lib/shareStore";
import OnboardingGuide from "../components/OnboardingGuide";
import SavedView from "../components/SavedView";
import { getSession, buildLoginUrl, isLoginConfigured, logout as sessionLogout, type Session } from "../lib/session";
import { fetchSaved } from "../lib/me";

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
  // Phase 1-B persistence contract: nullable capability-style id. Absent/null
  // means save/dismiss/events UI stays hidden for this item.
  rec_id?: string | null;
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
  // Phase 1-B persistence contract (nullable, additive): null/false with no
  // DB configured — every save/dismiss/events affordance stays hidden then.
  run_id?: string | null;
  persistence?: boolean;
};

export type TrackDiscoveryData = {
  tracks: TrackItem[];
  top_genres: GenreWeight[];
  active_seed_count: number;
  depth_score: number;
  message?: string;
};

type SortType = "composite" | "conviction" | "stickiness" | "listeners";
export type DiscoveryMode = "artists" | "tracks";

export const PERIOD_LABELS: Record<string, string> = {
  blend: "MIX",
  "7day": "7D",
  "1month": "1M",
  "3month": "3M",
  "6month": "6M",
  "12month": "1Y",
  overall: "ALL",
};

// Discovery-appetite slider stops: how much re-engagement (resurfacing obscure
// artists you've only lightly played) to mix into pure discovery. Maps to the
// backend's underexplored-novelty multiplier. Ordered new → rediscover.
export const APPETITE_STOPS: { val: string; label: string; blurb: string }[] = [
  { val: "new", label: "Only new", blurb: "Brand-new artists only" },
  { val: "low", label: "Mostly new", blurb: "Mostly new, a few rediscoveries" },
  { val: "balanced", label: "Balanced", blurb: "Even mix of new and rediscovered gems" },
  { val: "high", label: "Rediscover", blurb: "Resurface obscure gems you've barely played" },
];

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
  const [appetite, setAppetite] = useState("balanced");
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
  const [isSharedView, setIsSharedView] = useState(false);
  const [spotifyStatus, setSpotifyStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [shareKey, setShareKey] = useState(false);  // opt-in: contribute key to the shared pool
  const [focusedArtist, setFocusedArtist] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [persistence, setPersistence] = useState(false);
  const [session, setSessionState] = useState<Session | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [showSaved, setShowSaved] = useState(false);

  const lastFetchedUsernameRef = useRef<string | null>(null);
  const forceFreshRef = useRef(false);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [shareState, setShareState] = useState<"idle" | "rendering" | "saved" | "copied">("idle");

  useEffect(() => {
    // Last.fm session, if one was minted by a previous /auth/lastfm exchange.
    // Independent of the shared-view (?u=) branch below — a visitor can be
    // both viewing someone's shared results and logged in as themselves.
    setSessionState(getSession());

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
      const urlAppetite = params.get("a");
      if (urlAppetite && APPETITE_STOPS.some((s) => s.val === urlAppetite)) setAppetite(urlAppetite);
      if (urlMode === "tracks" || urlMode === "artists") setMode(urlMode as DiscoveryMode);
    } else {
      const saved = localStorage.getItem("obscurity_username");
      if (saved) setInputLocal(saved); // pre-fill input but don't auto-fetch; user submits
      const savedPeriod = localStorage.getItem("obscurity_period");
      if (savedPeriod && PERIOD_LABELS[savedPeriod]) setPeriod(savedPeriod);
      const savedAppetite = localStorage.getItem("obscurity_appetite");
      if (savedAppetite && APPETITE_STOPS.some((s) => s.val === savedAppetite)) setAppetite(savedAppetite);
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

  useEffect(() => {
    if (!isSharedView) localStorage.setItem("obscurity_appetite", appetite);
  }, [appetite, isSharedView]);

  // Reconcile the top-bar "saved" nav item with the backend's saved list
  // whenever a session appears — the quiet nav item shows only when the
  // user has >=1 save. Local optimistic save/unsave clicks adjust this
  // count directly via handleSavedCountDelta without a refetch.
  useEffect(() => {
    if (!session) { setSavedCount(0); return; }
    let cancelled = false;
    fetchSaved()
      .then((list) => { if (!cancelled) setSavedCount(list.length); })
      .catch(() => { /* best-effort — nav item just stays hidden until a save succeeds */ });
    return () => { cancelled = true; };
  }, [session]);

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
      setRunId(d.run_id ?? null);
      setPersistence(d.persistence === true);
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
        const cached = loadCache<DiscoveryData | TrackDiscoveryData>(username, period, mode, appetite);
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
          : `${apiUrl}/api/discovery?username=${encodeURIComponent(username)}&period=${period}&appetite=${appetite}${keyParam}`;
        // One automatic retry on a transient network drop (connection reset,
        // brief backend restart). New users on flaky mobile connections were
        // hitting a one-off "couldn't reach" that a manual retry fixed. We do
        // NOT auto-retry a 90s timeout (that would just double the wait).
        const fetchDiscovery = async (): Promise<Response> => {
          try {
            return await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") throw err;
            await new Promise((r) => setTimeout(r, 2000));
            return await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
          }
        };
        const response = await fetchDiscovery();
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
          saveCache(username, period, mode, appetite, data);
        } else {
          const data: DiscoveryData = await response.json();
          applyData(data, mode);
          saveCache(username, period, mode, appetite, data);
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
  }, [username, period, appetite, mode, fetchTrigger, applyData]);

  // Copy a shareable link. Preferred: persist the actual results via
  // POST /api/share and hand back a stable /r/{id} URL that opens the sender's
  // real results in any browser without recomputing. Fallback (store down, or
  // nothing worth persisting): today's ?u=&p=&a=&m= recompute-on-open URL.
  const copyShareUrl = async () => {
    if (!username) return;
    const origin = window.location.origin;
    const queryUrl = `${origin}${window.location.pathname}?u=${encodeURIComponent(username)}&p=${period}&a=${appetite}&m=${mode}`;
    let shareUrl = queryUrl;
    try {
      if (mode === "artists" && artists.length > 0) {
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            period,
            mode,
            appetite,
            recommendations: artists,
            computedAt: Date.now(),
          }),
        });
        if (res.ok) {
          const { id } = (await res.json()) as { id?: string };
          if (typeof id === "string" && id) shareUrl = `${origin}/r/${id}`;
        }
      }
    } catch {
      /* network / store failure — keep the query-param fallback URL */
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      /* clipboard unavailable — nothing further we can do */
    }
    setShareState("copied");
    setTimeout(() => setShareState("idle"), 2000);
  };

  // Export the 660×860 result card as a PNG (§8). Falls back to copying the
  // share URL when there's no artist result to render (tracks mode / empty).
  const handleShare = async () => {
    if (!username) return;
    const canExport =
      mode === "artists" && artists.length > 0 && depthScore > 0 && shareCardRef.current;
    if (!canExport) {
      await copyShareUrl();
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
      await copyShareUrl(); // never leave the button dead — copy the URL instead
    }
  };

  const handleRetry = () => {
    forceFreshRef.current = true;
    setFetchTrigger((t) => t + 1);
  };

  const handleSaveApiKey = (key: string, share = false) => {
    setApiKey(key);
    setApiKeyInput(key);
    if (key) localStorage.setItem("obscurity_api_key", key);
    else localStorage.removeItem("obscurity_api_key");
    setShowApiKey(false);
    // Opt-in: contribute the key to the shared rotation pool. Best-effort —
    // it speeds up discovery for everyone but must never block the user.
    if (share && key) {
      const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
      fetch(`${apiUrl}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      }).catch(() => {});
    }
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
    setRunId(null);
    setPersistence(false);
    setShowSaved(false);
  };

  // Quiet mono text link near the landing input (Surface spec). Hidden
  // entirely — not disabled — when NEXT_PUBLIC_LASTFM_API_KEY is unset.
  const handleConnectLastfm = () => {
    const url = buildLoginUrl();
    if (url) window.location.href = url;
  };

  const handleLogout = async () => {
    await sessionLogout();
    setSessionState(null);
    setSavedCount(0);
    setShowSaved(false);
  };

  // Bubbled up from ArtistList's useSaved hook on a confirmed save/unsave so
  // the top-bar nav item's visibility tracks reality without a refetch.
  const handleSavedCountDelta = useCallback((delta: number) => {
    setSavedCount((c) => Math.max(0, c + delta));
  }, []);

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

  const handleFocusArtist = useCallback((name: string) => {
    setFocusedArtist(null);
    setTimeout(() => setFocusedArtist(name), 0);
  }, []);

  return (
    <>
      {/* Fixed wordmark — landing view only. In the results view the
          wordmark now lives inside ResultsTopBar (contained in the single-
          row bar, not floating over it) so it never overlaps the bar's
          other controls at any width. */}
      {!username && (
        <div className="fixed top-0 left-0 z-50 px-6 h-12 flex items-center pointer-events-none">
          <span
            className="font-serif text-[13px] font-semibold tracking-wide cursor-pointer pointer-events-auto transition-opacity duration-200 hover:opacity-70"
            style={{ color: "var(--accent)" }}
            onClick={handleReset}
          >
            OBSCURITY ENGINE
          </span>
        </div>
      )}

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

              {/* Identity primitive entry point (Surface spec): quiet mono
                  text near the input, hidden entirely (not disabled) unless
                  NEXT_PUBLIC_LASTFM_API_KEY is configured. Once a session
                  exists this becomes a "connected as" line instead. */}
              {session ? (
                <p className="font-mono text-[11px] tracking-wide" style={{ color: "var(--muted)" }}>
                  connected as {session.username} ·{" "}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="transition-opacity duration-150 hover:opacity-60"
                    style={{ color: "var(--dim)" }}
                  >
                    log out
                  </button>
                </p>
              ) : (
                isLoginConfigured() && (
                  <button
                    type="button"
                    onClick={handleConnectLastfm}
                    className="font-mono text-[11px] tracking-wide transition-opacity duration-150 hover:opacity-60"
                    style={{ color: "var(--muted)" }}
                  >
                    connect last.fm
                  </button>
                )
              )}

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
                            onClick={() => handleSaveApiKey(apiKeyInput.trim(), shareKey)}
                            className="font-mono text-[10px] tracking-widest transition-opacity hover:opacity-60 shrink-0"
                            style={{ color: "var(--muted)" }}
                          >
                            {apiKeyInput.trim() ? "save" : "clear"}
                          </button>
                        </div>
                        {/* Opt-in: contribute the key to the shared rotation pool. */}
                        <button
                          type="button"
                          onClick={() => setShareKey((s) => !s)}
                          className="flex items-start gap-2 text-left transition-opacity hover:opacity-80"
                        >
                          <span
                            className="mt-[1px] shrink-0 flex items-center justify-center font-mono text-[9px]"
                            style={{
                              width: 14, height: 14, border: "1px solid var(--accent2)",
                              color: "var(--accent)",
                              background: shareKey ? "var(--accent)" : "transparent",
                            }}
                            aria-hidden
                          >
                            {shareKey ? "✓" : ""}
                          </span>
                          <span className="font-mono text-[9px] leading-relaxed tracking-wider" style={{ color: "var(--dim)" }}>
                            also share to the pool to speed up discovery for everyone (read-only app key, no account access)
                          </span>
                        </button>
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
            {/* Fixed top bar — single-row, contained (results-redesign §1) */}
            <ResultsTopBar
              username={username}
              onReset={handleReset}
              mode={mode}
              setMode={setMode}
              period={period}
              setPeriod={setPeriod}
              appetite={appetite}
              setAppetite={setAppetite}
              onRefresh={handleRetry}
              refreshDisabled={loading}
              isRefreshing={isRefreshing}
              shareState={shareState}
              onShare={handleShare}
              session={session}
              savedCount={savedCount}
              onShowSaved={() => setShowSaved(true)}
              onLogout={handleLogout}
            />

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

                    {/* Hero picks + Suggestions/Analytics tabs (results-redesign §2–3).
                        Analytics carries the Obscurity Index block + Discovery Matrix
                        that used to render unconditionally in the scroll flow. */}
                    {mode === "artists" && sortedArtists.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.6 }}
                      >
                        <ResultsBody
                          username={username}
                          mode={mode}
                          artists={artists}
                          listArtists={filteredArtists}
                          sortBy={sortBy}
                          setSortBy={(val) => setSortBy(val as SortType)}
                          depthScore={depthScore}
                          focusedArtist={focusedArtist}
                          onFocusArtist={handleFocusArtist}
                          session={session}
                          persistence={persistence}
                          runId={runId}
                          onSavedCountChange={handleSavedCountDelta}
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

            {/* Saved view — reachable via the quiet top-bar "saved" item. */}
            <AnimatePresence>
              {showSaved && session && (
                <SavedView onClose={() => setShowSaved(false)} onCountChange={setSavedCount} />
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

/**
 * Read-only rendering of a persisted share payload, used by the `/r/[id]` route.
 * Reuses the shared ResultsBody (hero + Suggestions/Analytics tabs) exactly as
 * the logged-in view does; the sort control stays live (local state) but there
 * is no input, refresh, share, or top bar — a viewer sees exactly the sender's
 * computed results, then a "get your own" CTA. Personal UI (save/dismiss,
 * session) stays hidden because no session/persistence/runId is passed —
 * ArtistCard's existing capability gate takes care of that, unchanged.
 * Exported from the client module so the `/r/[id]` server component can render
 * it (and SSR the artist names into the initial HTML) after fetching the store.
 */
export function ReadonlyResults({ payload }: { payload: SharePayload }) {
  const { username, period, recommendations } = payload;
  const [sortBy, setSortBy] = useState<SortType>("composite");

  const sortedArtists = useMemo(() => {
    const arr = [...recommendations];
    if (sortBy === "composite") arr.sort((a, b) => b.composite_score - a.composite_score);
    else if (sortBy === "conviction") arr.sort((a, b) => b.conviction_score - a.conviction_score);
    else if (sortBy === "stickiness") arr.sort((a, b) => b.stickiness_score - a.stickiness_score);
    else if (sortBy === "listeners") arr.sort((a, b) => b.total_listeners - a.total_listeners);
    return arr.sort((a, b) => {
      const aUntagged = a.top_tags.length === 0;
      const bUntagged = b.top_tags.length === 0;
      if (aUntagged === bUntagged) return 0;
      return aUntagged ? 1 : -1;
    });
  }, [recommendations, sortBy]);

  return (
    <>
      <div className="fixed top-0 left-0 z-50 px-6 h-12 flex items-center pointer-events-none">
        <a
          href="/"
          className="font-serif text-[13px] font-semibold tracking-wide pointer-events-auto transition-opacity duration-200 hover:opacity-70"
          style={{ color: "var(--accent)" }}
        >
          OBSCURITY ENGINE
        </a>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-8 pt-24 pb-16 flex flex-col gap-16">
        {/* Shared-view header */}
        <div className="flex flex-col gap-3 pb-8 border-b" style={{ borderColor: "var(--border)" }}>
          <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
            shared discovery
          </span>
          <h1
            className="font-serif text-4xl sm:text-5xl font-bold italic leading-none"
            style={{ color: "var(--text)" }}
          >
            {username}
          </h1>
          <p className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
            {PERIOD_WINDOWS[period] ?? period} · {recommendations.length} finds
          </p>
          <a
            href="/"
            className="font-mono text-[11px] tracking-widest transition-opacity duration-200 hover:opacity-60 w-fit"
            style={{ color: "var(--accent)" }}
          >
            get your own →
          </a>
        </div>

        {recommendations.length > 0 && (
          <ResultsBody
            username={username}
            mode="artists"
            artists={recommendations}
            listArtists={sortedArtists}
            sortBy={sortBy}
            setSortBy={(val) => setSortBy(val as SortType)}
            depthScore={0}
          />
        )}
      </div>
    </>
  );
}
