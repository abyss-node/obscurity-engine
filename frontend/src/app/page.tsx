"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
import * as Spotify from "../lib/spotify";
import OnboardingGuide from "../components/OnboardingGuide";
import SavedView from "../components/SavedView";
import { buildLoginUrl, isLoginConfigured, logout as sessionLogout } from "../lib/session";
import { fetchSaved } from "../lib/me";
import { useDiscovery } from "../lib/useDiscovery";
import { usePersistedPrefs } from "../lib/usePersistedPrefs";
import { useUrlModes } from "../lib/useUrlModes";
import { useShare } from "../lib/useShare";
import {
  PERIOD_WINDOWS,
  PERIOD_LABELS,
  APPETITE_STOPS,
  type SortType,
  type Artist,
  type TrackItem,
  type GenreWeight,
  type DiscoveryData,
  type TrackDiscoveryData,
  type DiscoveryMode,
} from "../lib/types";

// Re-exported for backward compatibility — this used to be page.tsx's own
// public surface, and many components/lib modules still import types from
// "../app/page". The definitions now live in ../lib/types; only the names
// that were previously exported from here are re-exported (SortType and
// PERIOD_WINDOWS were never part of the public surface, so they're
// import-only above).
export type { Artist, TrackItem, GenreWeight, DiscoveryData, TrackDiscoveryData, DiscoveryMode };
export { PERIOD_LABELS, APPETITE_STOPS };

export default function Home() {
  const [username, setUsername] = useState<string | null>(null);
  const [inputLocal, setInputLocal] = useState("");
  const [mode, setMode] = useState<DiscoveryMode>("artists");
  const [sortBy, setSortBy] = useState<SortType>("composite");
  const [selectedGeoTags, setSelectedGeoTags] = useState<string[]>([]);
  const [isSharedView, setIsSharedView] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [shareKey, setShareKey] = useState(false);  // opt-in: contribute key to the shared pool
  const [focusedArtist, setFocusedArtist] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [showSaved, setShowSaved] = useState(false);

  // selectedGeoTags lives here (feeds the geo-tag filter memo below, never
  // actually driven by any UI control today — see refactor notes) but the
  // discovery fetch effect resets it on every fetch; resetSelectedGeoTags
  // must stay referentially stable (empty dep array) so passing it into
  // useDiscovery doesn't change when that effect re-runs.
  const resetSelectedGeoTags = useCallback(() => setSelectedGeoTags([]), []);

  // period/appetite/apiKey(+Input) now live in usePersistedPrefs. Its
  // localStorage write-back effects for period/appetite are gated on
  // isSharedView, same as before the move.
  const prefs = usePersistedPrefs(isSharedView);

  // NOTE on hook-call order: useDiscovery and usePersistedPrefs are called
  // here, ahead of useUrlModes' mount/session/url-mode effect below, so
  // their setters (setTracks, setPeriod, setAppetite, setApiKey,
  // setApiKeyInput) are available to that effect's closure. This registers
  // their internal effects BEFORE the mount effect, the reverse of the
  // original page.tsx's source order (mount effect was declared first,
  // fetch/persist effects last). This re-ordering is safe: React defers all
  // setState calls made during an effect to the *next* render/commit, so
  // within any given commit every effect closes over the same pre-commit
  // state regardless of call order, and none of these effects share a
  // mutable ref with each other. Verified against the full 144-test suite
  // post-refactor.
  const discovery = useDiscovery(username, prefs.period, prefs.appetite, mode, prefs.apiKey, resetSelectedGeoTags);

  // isSharedView stays owned here (not inside useUrlModes) — see the
  // comment on useUrlModes' setIsSharedView param for why. The mount/
  // session/url-mode-callback effect itself (session read + Spotify OAuth
  // callback + ?u= shared-view vs. localStorage-restore, in that exact
  // load-bearing precedence order) moved verbatim into useUrlModes.
  const urlModes = useUrlModes({
    setUsername,
    setInputLocal,
    setMode,
    setTracks: discovery.setTracks,
    setIsSharedView,
    setPeriod: prefs.setPeriod,
    setAppetite: prefs.setAppetite,
    setApiKey: prefs.setApiKey,
    setApiKeyInput: prefs.setApiKeyInput,
  });

  // No internal effects (just state/refs + async click handlers), so unlike
  // the hooks above there's no hook-call-order concern with useShare.
  // Destructured (not `const share = ...`) to avoid shadowing the `share`
  // boolean parameter in handleSaveApiKey below.
  const { shareCardRef, shareState, handleShare } = useShare(
    username, mode, discovery.artists, discovery.depthScore, prefs.period, prefs.appetite
  );

  useEffect(() => {
    if (username && !isSharedView) localStorage.setItem("obscurity_username", username);
  }, [username, isSharedView]);

  // Reconcile the top-bar "saved" nav item with the backend's saved list
  // whenever a session appears — the quiet nav item shows only when the
  // user has >=1 save. Local optimistic save/unsave clicks adjust this
  // count directly via handleSavedCountDelta without a refetch.
  useEffect(() => {
    if (!urlModes.session) { setSavedCount(0); return; }
    let cancelled = false;
    fetchSaved()
      .then((list) => { if (!cancelled) setSavedCount(list.length); })
      .catch(() => { /* best-effort — nav item just stays hidden until a save succeeds */ });
    return () => { cancelled = true; };
  }, [urlModes.session]);

  // stickinessThreshold/availableGeoTags are computed but not consumed
  // anywhere (pre-existing dead code, preserved verbatim — see refactor
  // report; not fixed here per the "no logic edits" rule).
  const stickinessThreshold = useMemo(() => {
    if (discovery.artists.length < 1) return Infinity;
    const scores = discovery.artists.map((a) => a.stickiness_score).sort((a, b) => b - a);
    return scores[Math.max(0, Math.floor(scores.length * 0.1) - 1)] ?? Infinity;
  }, [discovery.artists]);

  const sortedArtists = useMemo(() => {
    const arr = [...discovery.artists];
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
  }, [discovery.artists, sortBy]);

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

  const handleRetry = discovery.retry;

  // localStorage write + optional shared-pool POST live in usePersistedPrefs;
  // setShowApiKey(false) is UI-modal state owned here, so this thin wrapper
  // just sequences the two — same net effect as the original single function
  // (the fire-and-forget /api/keys POST is unaffected by this reordering,
  // since it's already async/non-blocking either way).
  const handleSaveApiKey = (key: string, share = false) => {
    prefs.handleSaveApiKey(key, share);
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
    discovery.setArtists([]);
    discovery.setTracks([]);
    discovery.setTopGenres([]);
    discovery.setDepthScore(0);
    discovery.setError(null);
    urlModes.setSpotifyStatus("idle");
    urlModes.setPlaylistUrl(null);
    discovery.setRunId(null);
    discovery.setPersistence(false);
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
    urlModes.setSessionState(null);
    setSavedCount(0);
    setShowSaved(false);
  };

  // Bubbled up from ArtistList's useSaved hook on a confirmed save/unsave so
  // the top-bar nav item's visibility tracks reality without a refetch.
  const handleSavedCountDelta = useCallback((delta: number) => {
    setSavedCount((c) => Math.max(0, c + delta));
  }, []);

  const handleExportSpotify = async () => {
    if (!username || discovery.tracks.length === 0) return;
    if (!Spotify.isConfigured()) {
      alert("Spotify export is not configured. Set NEXT_PUBLIC_SPOTIFY_CLIENT_ID.");
      return;
    }
    await Spotify.initiateSpotifyAuth(discovery.tracks, username, prefs.period);
  };

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
                    discovery.setArtists([]);
                    discovery.setTopGenres([]);
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
              {urlModes.session ? (
                <p className="font-mono text-[11px] tracking-wide" style={{ color: "var(--muted)" }}>
                  connected as {urlModes.session.username} ·{" "}
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
                    style={{ color: prefs.apiKey ? "var(--accent)" : "var(--dim)" }}
                  >
                    {prefs.apiKey ? "api key active ▼" : `api key ${showApiKey ? "▲" : "▼"}`}
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
                            value={prefs.apiKeyInput}
                            onChange={(e) => prefs.setApiKeyInput(e.target.value)}
                            placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                            className="flex-1 bg-transparent border-b py-1 font-mono text-[11px] outline-none transition-colors duration-200"
                            style={{ borderColor: "var(--border)", color: "var(--text)", caretColor: "var(--accent)" }}
                          />
                          <button
                            onClick={() => handleSaveApiKey(prefs.apiKeyInput.trim(), shareKey)}
                            className="font-mono text-[10px] tracking-widest transition-opacity hover:opacity-60 shrink-0"
                            style={{ color: "var(--muted)" }}
                          >
                            {prefs.apiKeyInput.trim() ? "save" : "clear"}
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
              period={prefs.period}
              setPeriod={prefs.setPeriod}
              appetite={prefs.appetite}
              setAppetite={prefs.setAppetite}
              onRefresh={handleRetry}
              refreshDisabled={discovery.loading}
              isRefreshing={discovery.isRefreshing}
              shareState={shareState}
              onShare={handleShare}
              session={urlModes.session}
              savedCount={savedCount}
              onShowSaved={() => setShowSaved(true)}
              onLogout={handleLogout}
            />

            {/* Scrollable content (extra top pad on mobile clears the 2-row bar) */}
            <div className="pt-[68px] min-[720px]:pt-12 min-h-screen">
              <AnimatePresence mode="wait">
                {discovery.isInitialLoad ? (
                  <LoadingState wakingUp={discovery.wakingUp} />
                ) : discovery.error && !discovery.isRefreshing ? (
                  <ErrorState
                    error={discovery.error}
                    onRetry={handleRetry}
                    onAddApiKey={() => setShowApiKey(true)}
                  />
                ) : (
                  /* ── RESULTS ──────────────────────────────────────── */
                  <div className="max-w-4xl mx-auto px-4 sm:px-8 py-16 flex flex-col gap-16">
                    {mode === "artists" && discovery.lowDataMessage && sortedArtists.length > 0 && (
                      <div
                        className="border px-5 py-3"
                        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                      >
                        <p
                          className="font-mono text-[10px] tracking-wider leading-loose"
                          style={{ color: "var(--muted)" }}
                        >
                          [WARN] {discovery.lowDataMessage}
                        </p>
                      </div>
                    )}

                    {/* Empty states (§8) — no artists came back. Distinguish a
                        fresh 0-scrobble account (activeSeedCount === 0) from a
                        short period window that simply had no signal. */}
                    {mode === "artists" && !discovery.error && sortedArtists.length === 0 && (
                      <EmptyState
                        variant={discovery.activeSeedCount === 0 ? "fresh" : "short-window"}
                        windowLabel={PERIOD_WINDOWS[prefs.period] ?? "this window"}
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
                          artists={discovery.artists}
                          listArtists={filteredArtists}
                          sortBy={sortBy}
                          setSortBy={(val) => setSortBy(val as SortType)}
                          depthScore={discovery.depthScore}
                          focusedArtist={focusedArtist}
                          onFocusArtist={handleFocusArtist}
                          session={urlModes.session}
                          persistence={discovery.persistence}
                          runId={discovery.runId}
                          onSavedCountChange={handleSavedCountDelta}
                        />
                      </motion.div>
                    )}

                    {/* Tracks — gated behind a "Coming soon" overlay for alpha (§6) */}
                    {mode === "tracks" && (
                      <TracksComingSoon onBack={() => setMode("artists")} />
                    )}

                    {/* Track List */}
                    {mode === "tracks" && discovery.tracks.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.4, duration: 0.6 }}
                        className="flex flex-col gap-6"
                      >
                        {/* Spotify playlist */}
                        <div className="flex items-center gap-4">
                          {urlModes.spotifyStatus === "idle" && (
                            <button
                              onClick={handleExportSpotify}
                              className="font-mono text-[10px] tracking-widest border px-4 py-2 transition-opacity duration-150 hover:opacity-70 flex items-center gap-2"
                              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                            >
                              <span style={{ color: "#1DB954" }}>♫</span> add to spotify
                            </button>
                          )}
                          {urlModes.spotifyStatus === "loading" && (
                            <span className="font-mono text-[10px] tracking-widest animate-pulse" style={{ color: "var(--dim)" }}>
                              creating playlist...
                            </span>
                          )}
                          {urlModes.spotifyStatus === "success" && urlModes.playlistUrl && (
                            <a
                              href={urlModes.playlistUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-[10px] tracking-widest border px-4 py-2 transition-opacity duration-150 hover:opacity-70 flex items-center gap-2"
                              style={{ borderColor: "#1DB954", color: "#1DB954" }}
                            >
                              <span>♫</span> open playlist ↗
                            </a>
                          )}
                          {urlModes.spotifyStatus === "error" && (
                            <span className="font-mono text-[10px] tracking-widest" style={{ color: "var(--muted)" }}>
                              spotify export failed —{" "}
                              <button
                                onClick={() => urlModes.setSpotifyStatus("idle")}
                                className="transition-opacity hover:opacity-60"
                                style={{ color: "var(--accent)" }}
                              >
                                try again
                              </button>
                            </span>
                          )}
                        </div>

                        <TrackCard key={`${discovery.tracks[0].name}-hero`} track={discovery.tracks[0]} rank={1} isHero />
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {discovery.tracks.slice(1).map((track, idx) => (
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
                  initialValue={prefs.apiKey}
                  onSave={handleSaveApiKey}
                  onClose={() => setShowApiKey(false)}
                />
              )}
            </AnimatePresence>

            {/* Saved view — reachable via the quiet top-bar "saved" item. */}
            <AnimatePresence>
              {showSaved && urlModes.session && (
                <SavedView onClose={() => setShowSaved(false)} onCountChange={setSavedCount} />
              )}
            </AnimatePresence>

            {/* Off-screen 660×860 result card — the snapshot source for the
                top-bar "↑ share" PNG export (§8). Kept in the DOM (not display:none)
                so html-to-image can measure and render it; pushed off-screen and
                made non-interactive so it never affects layout or focus. */}
            {mode === "artists" && discovery.artists.length > 0 && discovery.depthScore > 0 && (
              <div
                aria-hidden
                style={{ position: "fixed", left: -9999, top: 0, pointerEvents: "none", opacity: 0 }}
              >
                <ShareCard
                  ref={shareCardRef}
                  username={username}
                  depthScore={discovery.depthScore}
                  verdict={discovery.depthProse ?? ""}
                  artists={sortedArtists}
                  topGenres={discovery.topGenres}
                  activeSeedCount={discovery.activeSeedCount}
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// Re-exported for backward compatibility — ReadonlyResults now lives in its
// own module (components/ReadonlyResults.tsx); app/r/[id]/page.tsx imports
// it from there directly, but keep this re-export in case anything else
// still resolves it via "../app/page" / "@/app/page".
export { ReadonlyResults } from "../components/ReadonlyResults";
