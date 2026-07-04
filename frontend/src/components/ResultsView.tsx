"use client";

import { motion, AnimatePresence } from "framer-motion";
import TrackCard from "./TrackCard";
import ResultsTopBar from "./ResultsTopBar";
import ResultsBody from "./ResultsBody";
import TracksComingSoon from "./TracksComingSoon";
import ApiKeyModal from "./ApiKeyModal";
import LoadingState from "./LoadingState";
import ErrorState from "./ErrorState";
import EmptyState from "./EmptyState";
import ShareCard from "./ShareCard";
import SavedView from "./SavedView";
import type { RefObject } from "react";
import type { Session } from "../lib/session";
import type { Artist, TrackItem, GenreWeight, DiscoveryMode, SortType } from "../lib/types";

type SpotifyStatus = "idle" | "loading" | "success" | "error";
type ShareState = "idle" | "rendering" | "saved" | "copied" | "saved-copied";

interface ResultsViewProps {
  username: string;
  mode: DiscoveryMode;
  setMode: (m: DiscoveryMode) => void;
  period: string;
  setPeriod: (p: string) => void;
  appetite: string;
  setAppetite: (a: string) => void;
  onReset: () => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
  isRefreshing: boolean;
  shareState: ShareState;
  onShare: () => void;
  session: Session | null;
  savedCount: number;
  onShowSaved: () => void;
  onLogout: () => void;

  isInitialLoad: boolean;
  wakingUp: boolean;
  error: string | null;
  onRetry: () => void;
  onAddApiKey: () => void;

  lowDataMessage: string | null;
  sortedArtists: Artist[];
  activeSeedCount: number;
  windowLabel: string;
  onCheckSetup: () => void;

  artists: Artist[];
  listArtists: Artist[];
  sortBy: SortType;
  setSortBy: (val: string) => void;
  depthScore: number;
  focusedArtist: string | null;
  onFocusArtist: (name: string) => void;
  persistence: boolean;
  runId: string | null;
  onSavedCountChange: (delta: number) => void;

  tracks: TrackItem[];
  spotifyStatus: SpotifyStatus;
  onExportSpotify: () => void;
  playlistUrl: string | null;
  onSpotifyStatusReset: () => void;

  showApiKey: boolean;
  apiKey: string;
  onSaveApiKey: (key: string, share?: boolean) => void;
  onCloseApiKey: () => void;

  showSaved: boolean;
  onCloseSaved: () => void;
  onSavedCountSet: (n: number) => void;

  depthProse: string | null;
  topGenres: GenreWeight[];
  shareCardRef: RefObject<HTMLDivElement | null>;
}

/**
 * The results (post-username) view, moved verbatim out of app/page.tsx's
 * `username` branch of the AnimatePresence. Home stays the thin
 * coordinator: it owns all the state/handlers (mostly sourced from the
 * useDiscovery/usePersistedPrefs/useUrlModes/useShare hooks) and threads
 * them through as props, unchanged in substance.
 */
export default function ResultsView({
  username,
  mode,
  setMode,
  period,
  setPeriod,
  appetite,
  setAppetite,
  onReset,
  onRefresh,
  refreshDisabled,
  isRefreshing,
  shareState,
  onShare,
  session,
  savedCount,
  onShowSaved,
  onLogout,
  isInitialLoad,
  wakingUp,
  error,
  onRetry,
  onAddApiKey,
  lowDataMessage,
  sortedArtists,
  activeSeedCount,
  windowLabel,
  onCheckSetup,
  artists,
  listArtists,
  sortBy,
  setSortBy,
  depthScore,
  focusedArtist,
  onFocusArtist,
  persistence,
  runId,
  onSavedCountChange,
  tracks,
  spotifyStatus,
  onExportSpotify,
  playlistUrl,
  onSpotifyStatusReset,
  showApiKey,
  apiKey,
  onSaveApiKey,
  onCloseApiKey,
  showSaved,
  onCloseSaved,
  onSavedCountSet,
  depthProse,
  topGenres,
  shareCardRef,
}: ResultsViewProps) {
  return (
    <motion.div
      key="results-shell"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Fixed top bar — single-row, contained (results-redesign §1) */}
      <ResultsTopBar
        username={username}
        onReset={onReset}
        mode={mode}
        setMode={setMode}
        period={period}
        setPeriod={setPeriod}
        appetite={appetite}
        setAppetite={setAppetite}
        onRefresh={onRefresh}
        refreshDisabled={refreshDisabled}
        isRefreshing={isRefreshing}
        shareState={shareState}
        onShare={onShare}
        session={session}
        savedCount={savedCount}
        onShowSaved={onShowSaved}
        onLogout={onLogout}
      />

      {/* Scrollable content (extra top pad on mobile clears the 2-row bar) */}
      <div className="pt-[68px] min-[720px]:pt-12 min-h-screen">
        <AnimatePresence mode="wait">
          {isInitialLoad ? (
            <LoadingState wakingUp={wakingUp} />
          ) : error && !isRefreshing ? (
            <ErrorState
              error={error}
              onRetry={onRetry}
              onAddApiKey={onAddApiKey}
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
                  windowLabel={windowLabel}
                  onCheckSetup={onCheckSetup}
                  onCheckAgain={onRetry}
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
                    listArtists={listArtists}
                    sortBy={sortBy}
                    setSortBy={(val) => setSortBy(val as SortType)}
                    depthScore={depthScore}
                    focusedArtist={focusedArtist}
                    onFocusArtist={onFocusArtist}
                    session={session}
                    persistence={persistence}
                    runId={runId}
                    onSavedCountChange={onSavedCountChange}
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
                        onClick={onExportSpotify}
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
                          onClick={onSpotifyStatusReset}
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
            onSave={onSaveApiKey}
            onClose={onCloseApiKey}
          />
        )}
      </AnimatePresence>

      {/* Saved view — reachable via the quiet top-bar "saved" item. */}
      <AnimatePresence>
        {showSaved && session && (
          <SavedView onClose={onCloseSaved} onCountChange={onSavedCountSet} />
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
  );
}
