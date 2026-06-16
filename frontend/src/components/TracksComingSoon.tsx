"use client";

import { motion } from "framer-motion";

interface TracksComingSoonProps {
  onBack: () => void;
}

// Tracks discovery isn't ready for alpha. Per the redesign (§6) we ghost a
// track-list skeleton behind a near-opaque overlay rather than expose a
// half-built mode.
export default function TracksComingSoon({ onBack }: TracksComingSoonProps) {
  return (
    <div className="relative py-4">
      {/* Ghosted skeleton */}
      <div
        className="flex flex-col gap-3 select-none pointer-events-none"
        style={{ filter: "blur(1.5px)", opacity: 0.45 }}
        aria-hidden
      >
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-3 py-3.5 border-b"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="font-mono text-[10px]" style={{ color: "var(--dim)" }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="flex flex-col gap-1.5 flex-1">
              <div style={{ height: 14, width: `${40 + ((i * 7) % 35)}%`, background: "var(--surface2)" }} />
              <div style={{ height: 8, width: `${20 + ((i * 5) % 20)}%`, background: "var(--surface)" }} />
            </div>
            <div style={{ height: 12, width: 40, background: "var(--surface2)" }} />
          </div>
        ))}
      </div>

      {/* Overlay */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-6"
        style={{ background: "rgba(8,8,6,0.93)" }}
      >
        <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
          tracks
        </span>
        <h2 className="font-serif italic text-4xl" style={{ color: "var(--text)" }}>
          Coming soon.
        </h2>
        <p className="font-body text-[15px] leading-relaxed max-w-md" style={{ color: "var(--muted)" }}>
          Track-level discovery — the same depth scoring, applied song by song.
          It&apos;s in the works.
        </p>
        <button
          onClick={onBack}
          className="mt-2 font-mono text-[10px] tracking-widest px-5 py-2 border transition-opacity duration-150 hover:opacity-70"
          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
        >
          ← back to artists
        </button>
      </motion.div>
    </div>
  );
}
