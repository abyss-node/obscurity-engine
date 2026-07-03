"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import LandingView from "../components/LandingView";
import ResultsView from "../components/ResultsView";
import { isGeoTag, GEO_CANONICAL } from "../lib/geoTags";
import * as Spotify from "../lib/spotify";
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

  // selectedGeoTags: feeds the geo-tag filter memo below (never actually
  // driven by any UI control today, see refactor notes); reset on every
  // discovery fetch, so this callback must stay referentially stable.
  const resetSelectedGeoTags = useCallback(() => setSelectedGeoTags([]), []);

  // --- Hook-call-order note (applies to prefs/discovery/urlModes below) ---
  // usePersistedPrefs and useDiscovery are called ahead of useUrlModes'
  // mount effect so it can receive their setters (setPeriod, setApiKey,
  // setTracks, ...). That registers their internal effects BEFORE the mount
  // effect — the reverse of the original page.tsx source order (mount
  // effect was declared first). Safe: React defers effect setState to the
  // *next* commit, so every effect in a given commit closes over that
  // commit's pre-existing state regardless of call order, and none of these
  // effects share a mutable ref. isSharedView itself stays owned here (not
  // inside useUrlModes) to break what would otherwise be a circular
  // hook-call dependency (prefs needs isSharedView; useUrlModes needs
  // prefs' setters). Verified against the full 144-test suite.
  const prefs = usePersistedPrefs(isSharedView);
  const discovery = useDiscovery(username, prefs.period, prefs.appetite, mode, prefs.apiKey, resetSelectedGeoTags);
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

  // useShare has no internal effects, so no call-order concern. Destructured
  // (not `const share = ...`) to avoid shadowing the `share` boolean
  // parameter in handleSaveApiKey below.
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

  // stickinessThreshold/availableGeoTags: computed but never consumed
  // anywhere (pre-existing dead code, preserved verbatim, not fixed here).
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

  // Persistence + shared-pool POST live in usePersistedPrefs; setShowApiKey
  // is UI-modal state owned here — this wrapper just sequences the two.
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

  // LandingView gates this call on inputLocal.trim() itself (same guard as
  // the original inline form handler).
  const handleSubmitUsername = () => {
    setIsSharedView(false);
    discovery.setArtists([]);
    discovery.setTopGenres([]);
    setUsername(inputLocal.trim());
  };

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
          // key on the AnimatePresence child itself (not just the nested
          // motion.div inside LandingView) preserves mode="wait" exit/enter
          // tracking exactly as when that motion.div was the direct child.
          <LandingView
            key="landing"
            inputLocal={inputLocal}
            setInputLocal={setInputLocal}
            onSubmitUsername={handleSubmitUsername}
            session={urlModes.session}
            onLogout={handleLogout}
            isLoginConfigured={isLoginConfigured()}
            onConnectLastfm={handleConnectLastfm}
            showSetup={showSetup}
            setShowSetup={setShowSetup}
            showApiKey={showApiKey}
            setShowApiKey={setShowApiKey}
            apiKey={prefs.apiKey}
            apiKeyInput={prefs.apiKeyInput}
            setApiKeyInput={prefs.setApiKeyInput}
            shareKey={shareKey}
            setShareKey={setShareKey}
            onSaveApiKey={handleSaveApiKey}
          />
        ) : (
          <ResultsView
            key="results-shell"
            username={username}
            mode={mode}
            setMode={setMode}
            period={prefs.period}
            setPeriod={prefs.setPeriod}
            appetite={prefs.appetite}
            setAppetite={prefs.setAppetite}
            onReset={handleReset}
            onRefresh={handleRetry}
            refreshDisabled={discovery.loading}
            isRefreshing={discovery.isRefreshing}
            shareState={shareState}
            onShare={handleShare}
            session={urlModes.session}
            savedCount={savedCount}
            onShowSaved={() => setShowSaved(true)}
            onLogout={handleLogout}
            isInitialLoad={discovery.isInitialLoad}
            wakingUp={discovery.wakingUp}
            error={discovery.error}
            onRetry={handleRetry}
            onAddApiKey={() => setShowApiKey(true)}
            lowDataMessage={discovery.lowDataMessage}
            sortedArtists={sortedArtists}
            activeSeedCount={discovery.activeSeedCount}
            windowLabel={PERIOD_WINDOWS[prefs.period] ?? "this window"}
            onCheckSetup={handleCheckSetup}
            artists={discovery.artists}
            listArtists={filteredArtists}
            sortBy={sortBy}
            setSortBy={(val) => setSortBy(val as SortType)}
            depthScore={discovery.depthScore}
            focusedArtist={focusedArtist}
            onFocusArtist={handleFocusArtist}
            persistence={discovery.persistence}
            runId={discovery.runId}
            onSavedCountChange={handleSavedCountDelta}
            tracks={discovery.tracks}
            spotifyStatus={urlModes.spotifyStatus}
            onExportSpotify={handleExportSpotify}
            playlistUrl={urlModes.playlistUrl}
            onSpotifyStatusReset={() => urlModes.setSpotifyStatus("idle")}
            showApiKey={showApiKey}
            apiKey={prefs.apiKey}
            onSaveApiKey={handleSaveApiKey}
            onCloseApiKey={() => setShowApiKey(false)}
            showSaved={showSaved}
            onCloseSaved={() => setShowSaved(false)}
            onSavedCountSet={setSavedCount}
            depthProse={discovery.depthProse}
            topGenres={discovery.topGenres}
            shareCardRef={shareCardRef}
          />
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
