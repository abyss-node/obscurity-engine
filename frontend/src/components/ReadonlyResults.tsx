"use client";

import { useMemo, useState } from "react";
import ResultsBody from "./ResultsBody";
import { PERIOD_WINDOWS, type SortType } from "../lib/types";
import type { SharePayload } from "../lib/shareStore";

/**
 * Read-only rendering of a persisted share payload, used by the `/r/[id]` route.
 * Reuses the shared ResultsBody (hero + Suggestions/Analytics tabs) exactly as
 * the logged-in view does; the sort control stays live (local state) but there
 * is no input, refresh, share, or top bar — a viewer sees exactly the sender's
 * computed results, then a "get your own" CTA. Personal UI (save/dismiss,
 * session) stays hidden because no session/persistence/runId is passed —
 * ArtistCard's existing capability gate takes care of that, unchanged.
 * Exported from its own module so the `/r/[id]` server component can render
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
