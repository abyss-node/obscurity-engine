"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import ArtistList from "./ArtistList";
import DiscoveryMatrix from "./DiscoveryMatrix";
import HeroPicks from "./HeroPicks";
import type { Artist } from "../app/page";
import type { Session } from "../lib/session";

type ResultsTab = "suggestions" | "analytics";

interface ResultsBodyProps {
  /** Identity of the current run — tab resets to "suggestions" whenever
   *  either changes (new username, or a mode switch back into artists). */
  username: string;
  mode: "artists" | "tracks";
  /** Raw candidate set (unsorted/unfiltered) — feeds the hero top-3
   *  selection and the Discovery Matrix, which plots the full set (capped
   *  defensively at 25, the backend's own result ceiling). */
  artists: Artist[];
  /** Sorted + filtered set rendered in the Suggestions tab's ArtistList. */
  listArtists: Artist[];
  sortBy: string;
  setSortBy: (val: string) => void;
  /** Feeds only the compact "obscurity index" readout in the hero header —
   *  the Analytics tab no longer has its own index block (Discovery Matrix
   *  is the tab's sole content). */
  depthScore: number;
  focusedArtist?: string | null;
  onFocusArtist?: (name: string) => void;
  // Phase 1-B persistence — optional so the read-only shared view (no
  // session/runId) renders with save/dismiss fully hidden, unchanged.
  session?: Session | null;
  persistence?: boolean;
  runId?: string | null;
  onSavedCountChange?: (delta: number) => void;
}

/**
 * Owns the Suggestions/Analytics tab state and renders, in order: the
 * top-3 hero picks, the tab bar, and the active tab's content. Shared by
 * both the logged-in results view and the read-only `/r/[id]` view (which
 * simply omits session/persistence/runId, hiding personal UI as before).
 */
export default function ResultsBody({
  username,
  mode,
  artists,
  listArtists,
  sortBy,
  setSortBy,
  depthScore,
  focusedArtist = null,
  onFocusArtist,
  session = null,
  persistence = false,
  runId = null,
  onSavedCountChange,
}: ResultsBodyProps) {
  const [tab, setTab] = useState<ResultsTab>("suggestions");

  // Reset to Suggestions on a new username or a mode switch — a stale
  // Analytics view from the previous run/mode should never persist.
  useEffect(() => {
    setTab("suggestions");
  }, [username, mode]);

  const handleMatrixClick = (name: string) => {
    setTab("suggestions");
    onFocusArtist?.(name);
  };

  return (
    <div className="flex flex-col">
      {mode === "artists" && (
        <HeroPicks artists={artists} depthScore={depthScore} runId={runId} />
      )}

      <div
        className="flex gap-7 mt-11 border-b"
        style={{ borderColor: "var(--border)" }}
        role="tablist"
      >
        {(["suggestions", "analytics"] as ResultsTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="font-mono text-[11px] tracking-[0.2em] uppercase pb-3.5 -mb-px transition-colors duration-150"
            style={{
              color: tab === t ? "var(--accent)" : "var(--muted)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Instant tab swap with a fade-in on the entering panel (results-redesign
          §"Interactions & Behavior"). Deliberately NOT wrapped in AnimatePresence
          exit/mode="wait" — the previous panel unmounts immediately so a matrix
          dot click (which switches tab + focuses a row in the same tick) can't
          be shadowed by a still-exiting sibling. */}
      {tab === "suggestions" ? (
        <motion.div
          key="suggestions"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="pt-6"
        >
          <ArtistList
            artists={listArtists}
            sortBy={sortBy}
            setSortBy={setSortBy}
            focusedArtist={focusedArtist}
            session={session}
            persistence={persistence}
            runId={runId}
            onSavedCountChange={onSavedCountChange}
          />
        </motion.div>
      ) : (
        <motion.div
          key="analytics"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="pt-7 flex flex-col gap-9"
        >
          {/* Discovery Matrix — the Analytics tab's sole content. The
              Obscurity Index block that used to live here was removed; the
              compact "obscurity index" readout in the hero header (above the
              tabs) is now the only place the score is displayed. */}
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span
                className="font-mono text-[10px] tracking-widest uppercase"
                style={{ color: "var(--dim)" }}
              >
                discovery matrix
              </span>
              <span className="font-mono text-[9px] tracking-wider" style={{ color: "var(--dim)", opacity: 0.7 }}>
                conviction × stickiness · dot size = obscurity · click a dot to open its row
              </span>
            </div>
            <DiscoveryMatrix artists={artists.slice(0, 25)} onArtistClick={handleMatrixClick} />
          </div>
        </motion.div>
      )}
    </div>
  );
}
