"use client";

import { useState, useEffect, useMemo } from "react";
import { Artist } from "../app/page";
import ArtistCard from "./ArtistCard";
import Tooltip from "./Tooltip";
import { formatGeoTag } from "../lib/geoTags";
import { motion, AnimatePresence } from "framer-motion";

interface ArtistListProps {
  artists: Artist[];
  sortBy: string;
  setSortBy: (val: string) => void;
  stickinessThreshold: number;
  availableGeoTags: { tag: string; count: number }[];
  selectedGeoTags: string[];
  setSelectedGeoTags: (tags: string[]) => void;
  focusedArtist?: string | null;
}

const listVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0 },
  },
};

const SORT_OPTIONS = [
  { id: "composite",  label: "composite",  tip: "Conviction × stickiness. Default rank — balances how strongly your history points to an artist with how dedicated their fanbase is." },
  { id: "conviction", label: "conviction", tip: "How many of your seed artists independently point to this one. Multiple signals from different parts of your taste carry more weight." },
  { id: "stickiness", label: "stickiness", tip: "Monthly listeners ÷ total listeners. A high ratio means people who discover this artist keep coming back — the fanbase is active, not passive." },
  { id: "listeners",  label: "listeners",  tip: "Raw Last.fm listener count. Sort ascending to find the deepest cuts — artists few people have heard of yet." },
];

const COLS = 3;

function tagMatchScore(query: string, tags: string[]): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let best = 0;
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t === q) return 1.0;
    if (t.includes(q)) { best = Math.max(best, 0.9); continue; }
    if (q.includes(t)) { best = Math.max(best, 0.7); continue; }
    const qWords = q.split(" ").filter(Boolean);
    const tWords = t.split(" ").filter(Boolean);
    let wordMatches = 0;
    for (const qw of qWords) {
      if (tWords.some(tw => tw.startsWith(qw) || qw.startsWith(tw))) wordMatches++;
    }
    if (wordMatches > 0) {
      best = Math.max(best, (wordMatches / Math.max(qWords.length, 1)) * 0.5);
    }
  }
  return best;
}

export default function ArtistList({
  artists,
  sortBy,
  setSortBy,
  stickinessThreshold,
  availableGeoTags,
  selectedGeoTags,
  setSelectedGeoTags,
  focusedArtist,
}: ArtistListProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [genreQuery, setGenreQuery] = useState("");
  const [selectedVia, setSelectedVia] = useState<string[]>([]);

  const toggleRow = (rowIndex: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  useEffect(() => {
    if (!focusedArtist) return;
    const idx = artists.slice(1).findIndex(a => a.name === focusedArtist);
    if (idx >= 0) {
      setExpandedRows(prev => new Set(prev).add(Math.floor(idx / COLS)));
    }
  }, [focusedArtist, artists]);

  // Build via seed list from all artists, sorted by frequency
  const availableVia = useMemo(() => {
    const counts = new Map<string, number>();
    for (const artist of artists) {
      for (const seed of artist.source_seeds ?? []) {
        counts.set(seed.name, (counts.get(seed.name) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));
  }, [artists]);

  // Apply genre fuzzy filter/sort and via filter on top of the parent-sorted list
  const displayArtists = useMemo(() => {
    let result = artists;

    if (selectedVia.length > 0) {
      result = result.filter(a =>
        a.source_seeds?.some(s => selectedVia.includes(s.name))
      );
    }

    const q = genreQuery.trim();
    if (q) {
      const scored = result
        .map(a => ({ artist: a, score: tagMatchScore(q, a.top_tags) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      result = scored.map(({ artist }) => artist);
    }

    return result;
  }, [artists, genreQuery, selectedVia]);

  const toggleGeo = (tag: string) => {
    setSelectedGeoTags(
      selectedGeoTags.includes(tag)
        ? selectedGeoTags.filter(t => t !== tag)
        : [...selectedGeoTags, tag]
    );
  };

  const toggleVia = (name: string) => {
    setSelectedVia(prev =>
      prev.includes(name) ? prev.filter(v => v !== name) : [...prev, name]
    );
  };

  const hasActiveFilters = genreQuery.trim() || selectedVia.length > 0;

  return (
    <div className="w-full flex flex-col gap-10">
      {/* Controls */}
      <div className="flex flex-col gap-6">

        {/* Sort — sticky so you can re-sort without scrolling back */}
        <div
          className="sticky top-12 z-30 flex flex-col gap-3 py-4 -mx-4 px-4 sm:-mx-8 sm:px-8"
          style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}
        >
          <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
            sort by
          </span>
          <div className="flex flex-wrap gap-2">
            {SORT_OPTIONS.map((opt) => (
              <Tooltip key={opt.id} text={opt.tip}>
                <button
                  onClick={() => setSortBy(opt.id)}
                  className="font-mono text-[10px] tracking-wider px-3 py-1.5 border transition-colors duration-150"
                  style={{
                    borderColor: sortBy === opt.id && !genreQuery.trim() ? "var(--accent)" : "var(--border)",
                    color: sortBy === opt.id && !genreQuery.trim() ? "var(--accent)" : "var(--dim)",
                  }}
                >
                  {opt.label}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>

        {/* Genre fuzzy search */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
              sort by genre
            </span>
            {genreQuery && (
              <button
                onClick={() => setGenreQuery("")}
                className="font-mono text-[9px] tracking-wider transition-opacity hover:opacity-60"
                style={{ color: "var(--dim)" }}
              >
                clear
              </button>
            )}
          </div>
          <input
            type="text"
            value={genreQuery}
            onChange={e => setGenreQuery(e.target.value)}
            placeholder="e.g. black metal, doom, shoegaze..."
            className="w-full max-w-xs bg-transparent border px-3 py-1.5 font-mono text-[10px] tracking-wider outline-none transition-colors duration-150"
            style={{
              borderColor: genreQuery ? "var(--accent)" : "var(--border)",
              color: "var(--text)",
            }}
            onFocus={e => (e.currentTarget.style.borderColor = "var(--dim)")}
            onBlur={e => (e.currentTarget.style.borderColor = genreQuery ? "var(--accent)" : "var(--border)")}
          />
        </div>

        {/* Geo filter */}
        {availableGeoTags.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                filter by origin
              </span>
              {selectedGeoTags.length > 0 && (
                <button
                  onClick={() => setSelectedGeoTags([])}
                  className="font-mono text-[9px] tracking-wider transition-opacity hover:opacity-60"
                  style={{ color: "var(--dim)" }}
                >
                  clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {availableGeoTags.map(({ tag, count }) => {
                const active = selectedGeoTags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => toggleGeo(tag)}
                    className="font-mono text-[10px] tracking-wider px-3 py-1.5 border transition-colors duration-150"
                    style={{
                      borderColor: active ? "var(--accent)" : "var(--border)",
                      color: active ? "var(--accent)" : "var(--dim)",
                    }}
                  >
                    {formatGeoTag(tag)}
                    <span className="ml-1.5 opacity-40">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Via filter */}
        {availableVia.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                filter by via
              </span>
              {selectedVia.length > 0 && (
                <button
                  onClick={() => setSelectedVia([])}
                  className="font-mono text-[9px] tracking-wider transition-opacity hover:opacity-60"
                  style={{ color: "var(--dim)" }}
                >
                  clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {availableVia.map(({ name, count }) => {
                const active = selectedVia.includes(name);
                return (
                  <button
                    key={name}
                    onClick={() => toggleVia(name)}
                    className="font-mono text-[10px] tracking-wider px-3 py-1.5 border transition-colors duration-150"
                    style={{
                      borderColor: active ? "var(--accent)" : "var(--border)",
                      color: active ? "var(--accent)" : "var(--dim)",
                    }}
                  >
                    {name}
                    <span className="ml-1.5 opacity-40">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Artist grid */}
      <AnimatePresence mode="wait">
        {displayArtists.length === 0 ? (
          <motion.p
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="font-mono text-[11px] tracking-wider"
            style={{ color: "var(--dim)" }}
          >
            {hasActiveFilters ? "no artists match the active filters" : "no artists match the selected filter"}
          </motion.p>
        ) : (
          <motion.div
            key="grid"
            variants={listVariants}
            initial="hidden"
            animate="visible"
            className="flex flex-col gap-6 w-full"
          >
            <ArtistCard
              key={`${displayArtists[0].name}-hero`}
              artist={displayArtists[0]}
              rank={1}
              stickinessThreshold={stickinessThreshold}
              isHero
              isFocused={focusedArtist === displayArtists[0].name}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {displayArtists.slice(1).map((artist, idx) => {
                const rowIndex = Math.floor(idx / COLS);
                return (
                  <ArtistCard
                    key={`${artist.name}-${idx + 1}`}
                    artist={artist}
                    rank={idx + 2}
                    stickinessThreshold={stickinessThreshold}
                    isFocused={focusedArtist === artist.name}
                    isExpanded={expandedRows.has(rowIndex)}
                    onToggle={() => toggleRow(rowIndex)}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
