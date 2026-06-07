"use client";

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
}

const listVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05, delayChildren: 0 },
  },
};

const SORT_OPTIONS = [
  { id: "composite",  label: "composite",  tip: "Conviction × stickiness. Balances how strongly your taste recommends an artist with how dedicated their fanbase is." },
  { id: "conviction", label: "conviction", tip: "How many artists you already love point toward this one. Multiple independent signals from your listening history." },
  { id: "stickiness", label: "stickiness", tip: "Ratio of monthly to total listeners. High stickiness = people who find this artist keep coming back." },
  { id: "listeners",  label: "listeners",  tip: "Raw Last.fm listener count. Sort to find the deepest cuts." },
];

export default function ArtistList({
  artists,
  sortBy,
  setSortBy,
  stickinessThreshold,
  availableGeoTags,
  selectedGeoTags,
  setSelectedGeoTags,
}: ArtistListProps) {
  const toggleGeo = (tag: string) => {
    setSelectedGeoTags(
      selectedGeoTags.includes(tag)
        ? selectedGeoTags.filter(t => t !== tag)
        : [...selectedGeoTags, tag]
    );
  };

  return (
    <div className="w-full flex flex-col gap-10">
      {/* Controls row */}
      <div className="flex flex-col gap-6">
        {/* Sort */}
        <div className="flex flex-col gap-3">
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
                    borderColor: sortBy === opt.id ? "var(--accent)" : "var(--border)",
                    color: sortBy === opt.id ? "var(--accent)" : "var(--dim)",
                  }}
                >
                  {opt.label}
                </button>
              </Tooltip>
            ))}
          </div>
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
      </div>

      {/* Artist grid */}
      <AnimatePresence mode="wait">
        {artists.length === 0 ? (
          <motion.p
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="font-mono text-[11px] tracking-wider"
            style={{ color: "var(--dim)" }}
          >
            no artists match the selected filter
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
              key={`${artists[0].name}-hero`}
              artist={artists[0]}
              rank={1}
              stickinessThreshold={stickinessThreshold}
              isHero
            />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {artists.slice(1).map((artist, idx) => (
                <ArtistCard
                  key={`${artist.name}-${idx + 1}`}
                  artist={artist}
                  rank={idx + 2}
                  stickinessThreshold={stickinessThreshold}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
