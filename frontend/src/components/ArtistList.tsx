"use client";

import { useEffect, useState } from "react";
import { Artist } from "../app/page";
import ArtistCard from "./ArtistCard";
import Tooltip from "./Tooltip";

interface ArtistListProps {
  artists: Artist[];
  sortBy: string;
  setSortBy: (val: string) => void;
  focusedArtist?: string | null;
}

const SORT_OPTIONS = [
  { id: "composite",  label: "composite",  tip: "Conviction × stickiness. Default rank — balances how strongly your history points to an artist with how dedicated their fanbase is." },
  { id: "conviction", label: "conviction", tip: "How many of your seed artists independently point to this one. Multiple signals from different parts of your taste carry more weight." },
  { id: "stickiness", label: "stickiness", tip: "Monthly listeners ÷ total listeners. A high ratio means people who discover this artist keep coming back — the fanbase is active, not passive." },
  { id: "listeners",  label: "listeners",  tip: "Raw Last.fm listener count. Sort ascending to find the deepest cuts — artists few people have heard of yet." },
];

// Shared grid template — column header row must line up with each ledger row.
// Keep in sync with `ledgerCols` in ArtistCard.tsx.
const ledgerCols =
  "grid-cols-[20px_minmax(0,1fr)_40px_46px_16px] min-[720px]:grid-cols-[26px_minmax(0,1fr)_148px_104px_70px_74px_22px]";

export default function ArtistList({ artists, sortBy, setSortBy, focusedArtist }: ArtistListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // A matrix dot click focuses an artist — open and scroll to its row.
  useEffect(() => {
    if (focusedArtist) setExpanded(focusedArtist);
  }, [focusedArtist]);

  return (
    <div className="w-full flex flex-col gap-5">
      {/* Sort tabs */}
      <div
        className="sticky top-[68px] min-[720px]:top-12 z-30 flex items-center gap-3 min-[720px]:gap-6 py-3 -mx-4 px-4 sm:-mx-8 sm:px-8 overflow-x-auto"
        style={{ background: "var(--bg)" }}
      >
        <span className="font-mono text-[8px] tracking-widest uppercase shrink-0" style={{ color: "var(--dim)" }}>
          sort by
        </span>
        <div className="flex items-center gap-4 min-[720px]:gap-5 shrink-0">
          {SORT_OPTIONS.map((opt) => {
            const active = sortBy === opt.id;
            return (
              <Tooltip key={opt.id} text={opt.tip}>
                <button
                  onClick={() => setSortBy(opt.id)}
                  className="font-mono text-[11px] tracking-wider pb-1 transition-colors duration-150"
                  style={{
                    color: active ? "var(--accent)" : "var(--muted)",
                    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                  }}
                >
                  {opt.label}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* Ledger */}
      <div className="w-full">
        {/* Column header */}
        <div
          className={`grid w-full items-center gap-2.5 min-[720px]:gap-4 px-3 pb-2.5 border-b ${ledgerCols}`}
          style={{ borderColor: "var(--border)" }}
        >
          <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>#</span>
          <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>artist</span>
          <span className="hidden min-[720px]:block font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>genre</span>
          <span className="hidden min-[720px]:block font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>country</span>
          <span className="font-mono text-[8px] tracking-widest uppercase text-center" style={{ color: "var(--dim)" }}>conviction</span>
          <span className="font-mono text-[8px] tracking-widest uppercase text-center" style={{ color: "var(--dim)" }}>listeners</span>
          <span />
        </div>

        {/* Rows */}
        {artists.length === 0 ? (
          <p className="font-mono text-[11px] tracking-wider px-3 py-6" style={{ color: "var(--dim)" }}>
            no artists for this period
          </p>
        ) : (
          artists.map((artist, idx) => (
            <ArtistCard
              key={`${artist.name}-${idx}`}
              artist={artist}
              rank={idx + 1}
              expanded={expanded === artist.name}
              onToggle={() => setExpanded((cur) => (cur === artist.name ? null : artist.name))}
              isFocused={focusedArtist === artist.name}
            />
          ))
        )}
      </div>
    </div>
  );
}
