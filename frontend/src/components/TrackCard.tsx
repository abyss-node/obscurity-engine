"use client";

import { useState } from "react";
import { TrackItem } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";
import Tooltip from "./Tooltip";

interface TrackCardProps {
  track: TrackItem;
  rank: number;
  isHero?: boolean;
}

type PreviewState = "idle" | "loading" | { id: string } | "error";

function formatListeners(n: number): string {
  if (n === 0) return "unknown listeners";
  if (n < 1000) return `${n} listeners`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K listeners`;
  return `${Math.round(n / 1000)}K listeners`;
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 80, damping: 20 },
  },
};

export default function TrackCard({ track, rank, isHero }: TrackCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [preview, setPreview] = useState<PreviewState>("idle");

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof preview === "object") {
      // already loaded — toggle iframe visibility by resetting
      setPreview("idle");
      return;
    }
    if (preview === "loading") return;
    setPreview("loading");
    try {
      const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
      const res = await fetch(
        `${apiUrl}/api/spotify/track?artist=${encodeURIComponent(track.artist)}&track=${encodeURIComponent(track.name)}`
      );
      if (!res.ok) { setPreview("error"); return; }
      const data = await res.json();
      setPreview({ id: data.id });
    } catch {
      setPreview("error");
    }
  };

  const previewLoaded = typeof preview === "object";

  return (
    <motion.div
      layout
      variants={itemVariants}
      onClick={() => setIsExpanded(!isExpanded)}
      className={`relative cursor-pointer border transition-colors duration-150 flex flex-col
        ${isHero ? "p-10 md:p-14" : "p-6 md:p-8"}`}
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--dim)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--border)")}
    >
      <div className="flex flex-col gap-3">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div className="flex flex-col gap-1 pr-4 flex-1">
            <h3
              className={`font-serif font-semibold leading-tight ${
                isHero ? "text-3xl md:text-5xl" : "text-xl md:text-2xl"
              }`}
              style={{ color: "var(--text)" }}
            >
              {track.name}
            </h3>
            <span
              className="font-mono text-[11px] tracking-wider"
              style={{ color: "var(--muted)" }}
            >
              {track.artist}
            </span>
            {track.top_tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--muted)" }}>
                  {track.top_tags[0]}
                </span>
                <AnimatePresence>
                  {isExpanded && track.top_tags.slice(1, 4).map((tag) => (
                    <motion.span
                      key={tag}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="font-mono text-[10px] tracking-widest uppercase"
                      style={{ color: "var(--dim)" }}
                    >
                      {tag}
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
            )}
            <Tooltip text="Total unique listeners on Last.fm globally. Lower = deeper cut.">
              <span className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
                {formatListeners(track.total_listeners)}
              </span>
            </Tooltip>
          </div>

          {/* Top-right: preview button + rank */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="font-mono text-[9px] tracking-widest" style={{ color: "var(--dim)" }}>
              /{rank.toString().padStart(2, "0")}
            </span>
            <button
              onClick={handlePreview}
              title={previewLoaded ? "Hide preview" : "Preview on Spotify"}
              className="font-mono text-[9px] tracking-widest border px-2 py-1 transition-all duration-150"
              style={{
                borderColor: previewLoaded ? "#1DB954" : "var(--border)",
                color: previewLoaded ? "#1DB954" : "var(--dim)",
              }}
            >
              {preview === "loading" ? "..." : previewLoaded ? "▶ hide" : "▶"}
            </button>
          </div>
        </div>

        {/* Spotify embed — appears when preview loaded */}
        <AnimatePresence>
          {previewLoaded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <iframe
                src={`https://open.spotify.com/embed/track/${(preview as { id: string }).id}?utm_source=generator&theme=0`}
                width="100%"
                height="80"
                frameBorder="0"
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                loading="lazy"
                className="rounded-sm mt-2"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {preview === "error" && (
          <p className="font-mono text-[9px] tracking-wider" style={{ color: "var(--dim)" }}>
            not found on spotify
          </p>
        )}

        {/* Expandable details */}
        <motion.div
          layout
          initial={false}
          animate={{ height: isExpanded ? "auto" : 0, opacity: isExpanded ? 1 : 0 }}
          className="overflow-hidden"
        >
          <div className="mt-6 pt-6 border-t flex flex-col gap-5" style={{ borderColor: "var(--border)" }}>
            <div className="grid grid-cols-3 gap-6">
              <div className="flex flex-col gap-1">
                <Tooltip text="How strongly your listening history points toward this track. 10 = recommended by many of your top artists.">
                  <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>conviction</span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {Math.min(track.conviction_score / 300, 10).toFixed(1)}<span className="text-[10px]" style={{ color: "var(--dim)" }}>/10</span>
                </span>
              </div>
              <div className="flex flex-col gap-1 border-l pl-6" style={{ borderColor: "var(--border)" }}>
                <Tooltip text="Plays-per-listener ratio — high stickiness means fans keep coming back. 10 = extremely dedicated fanbase.">
                  <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>stickiness</span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {Math.min(track.stickiness_score / 2, 10).toFixed(1)}<span className="text-[10px]" style={{ color: "var(--dim)" }}>/10</span>
                </span>
              </div>
              <div className="flex flex-col gap-1 border-l pl-6" style={{ borderColor: "var(--border)" }}>
                <Tooltip text="Total unique listeners on Last.fm.">
                  <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>listeners</span>
                </Tooltip>
                <span className="font-mono text-base" style={{ color: "var(--text)" }}>
                  {track.total_listeners.toLocaleString()}
                </span>
              </div>
            </div>

            {track.source_seeds.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                  via
                </span>
                <span className="font-mono text-[10px]" style={{ color: "var(--muted)" }}>
                  {track.source_seeds[0].track} — {track.source_seeds[0].artist}
                </span>
              </div>
            )}

            <a
              href={`https://www.last.fm/music/${encodeURIComponent(track.artist)}/_/${encodeURIComponent(track.name)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="w-full py-3 text-center border font-mono text-[10px] tracking-widest uppercase transition-opacity duration-150 hover:opacity-70"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            >
              view on last.fm →
            </a>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
