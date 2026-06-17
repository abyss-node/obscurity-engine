"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Artist } from "../app/page";
import { normConviction, normStickiness, obscurityDotSize } from "../lib/scoring";

type DiscoveryMatrixProps = {
  artists: Artist[];
  onArtistClick?: (name: string) => void;
};

// Matrix-local hexes that aren't global tokens (documented in the design spec).
const NEUTRAL_DOT = "#7A7265"; // = --muted
const NEUTRAL_DOT_BORDER = "#5A5249";
const NEUTRAL_LABEL = "#9A9082";
const NEUTRAL_LABEL_HOVER = "#B5AC9C";
const QUADRANT = "#6E665A";
const GRIDLINE = "#1A1916"; // = --surface2

type Dot = {
  name: string;
  x: number;
  y: number;
  size: number;
  dual: boolean;
  labelRight: boolean;
};

export default function DiscoveryMatrix({ artists, onArtistClick }: DiscoveryMatrixProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const dots = useMemo<Dot[]>(
    () =>
      artists.map((a) => {
        const conviction = normConviction(a);
        const stickiness = normStickiness(a);
        return {
          name: a.name,
          x: 8 + (conviction / 100) * 84,
          y: 92 - (stickiness / 100) * 84, // invert: high stickiness → top
          size: obscurityDotSize(a.total_listeners),
          dual: !!a.cross_validated,
          labelRight: conviction < 70,
        };
      }),
    [artists]
  );

  // Vertically de-collide the always-on (dual-signal) labels: when several dual
  // dots cluster at a similar height (e.g. three high-conviction finds), stack
  // their labels downward in fixed px steps so they don't overprint each other.
  // Deterministic order (y, then name) keeps it stable across renders.
  const labelDy = useMemo(() => {
    const out: Record<string, number> = {};
    const cluster = dots
      .filter((d) => d.dual)
      .sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));
    let lastY = -999;
    let run = 0;
    for (const d of cluster) {
      run = d.y - lastY < 7 ? run + 1 : 0;
      out[d.name] = run * 15;
      lastY = d.y;
    }
    return out;
  }, [dots]);

  if (artists.length === 0) {
    return (
      <div
        className="w-full flex items-center justify-center py-10 font-mono text-[10px] tracking-widest uppercase animate-pulse"
        style={{ color: "var(--dim)" }}
      >
        awaiting sonar data...
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-[18px]">
      <div className="grid" style={{ gridTemplateColumns: "32px 1fr" }}>
        {/* Y-axis caption */}
        <div className="flex items-center justify-center">
          <span
            className="font-mono text-[10px] uppercase whitespace-nowrap"
            style={{ color: "var(--muted)", letterSpacing: "0.2em", transform: "rotate(-90deg)" }}
          >
            stickiness →
          </span>
        </div>

        <div className="flex flex-col">
          {/* Plot */}
          <div
            className="relative h-[400px] min-[720px]:h-[520px] overflow-hidden border"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
          >
            {/* Quadrant gridlines */}
            <div className="absolute top-0 bottom-0" style={{ left: "50%", width: 1, background: GRIDLINE }} />
            <div className="absolute left-0 right-0" style={{ top: "50%", height: 1, background: GRIDLINE }} />

            {/* Quadrant labels */}
            <div className="absolute flex flex-col gap-[3px] text-right" style={{ right: 18, top: 16 }}>
              <span className="font-mono text-[11px] uppercase" style={{ color: "var(--accent)", letterSpacing: "0.18em" }}>keepers</span>
              <span className="font-mono text-[9px]" style={{ color: "var(--dim)" }}>love now · love later</span>
            </div>
            <div className="absolute flex flex-col gap-[3px]" style={{ left: 18, top: 16 }}>
              <span className="font-mono text-[11px] uppercase" style={{ color: QUADRANT, letterSpacing: "0.18em" }}>growers</span>
              <span className="font-mono text-[9px]" style={{ color: "var(--dim)" }}>slow burn</span>
            </div>
            <div className="absolute flex flex-col gap-[3px] text-right" style={{ right: 18, bottom: 34 }}>
              <span className="font-mono text-[11px] uppercase" style={{ color: QUADRANT, letterSpacing: "0.18em" }}>quick hits</span>
              <span className="font-mono text-[9px]" style={{ color: "var(--dim)" }}>instant · may fade</span>
            </div>
            <div className="absolute flex flex-col gap-[3px]" style={{ left: 18, bottom: 34 }}>
              <span className="font-mono text-[11px] uppercase" style={{ color: QUADRANT, letterSpacing: "0.18em" }}>wildcards</span>
              <span className="font-mono text-[9px]" style={{ color: "var(--dim)" }}>a gamble</span>
            </div>

            {/* Dots */}
            {dots.map((d) => {
              const isHovered = hovered === d.name;
              const showLabel = d.dual || isHovered;
              const labelColor = d.dual
                ? "var(--accent)"
                : isHovered
                  ? NEUTRAL_LABEL_HOVER
                  : NEUTRAL_LABEL;
              const glow = d.dual
                ? "0 0 12px rgba(184,131,46,0.55)"
                : isHovered
                  ? "0 0 10px rgba(237,232,220,0.3)"
                  : "none";
              const dotBg = d.dual ? "var(--accent)" : isHovered ? NEUTRAL_LABEL_HOVER : NEUTRAL_DOT;
              const offset = d.size / 2 + 7;
              return (
                <motion.button
                  key={d.name}
                  type="button"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  onMouseEnter={() => setHovered(d.name)}
                  onMouseLeave={() => setHovered((h) => (h === d.name ? null : h))}
                  onClick={() => {
                    setHovered(d.name);
                    onArtistClick?.(d.name);
                  }}
                  className="absolute"
                  style={{ left: `${d.x}%`, top: `${d.y}%`, zIndex: isHovered ? 20 : showLabel ? 10 : 1 }}
                  aria-label={d.name}
                >
                  <span
                    className="absolute rounded-full"
                    style={{
                      left: 0,
                      top: 0,
                      transform: "translate(-50%,-50%)",
                      width: d.size,
                      height: d.size,
                      background: dotBg,
                      border: d.dual ? "none" : `1px solid ${NEUTRAL_DOT_BORDER}`,
                      boxShadow: glow,
                      transition: "background 150ms, box-shadow 150ms",
                    }}
                  />
                  {showLabel && (
                    <span
                      className="absolute font-mono whitespace-nowrap"
                      style={{
                        top: 0,
                        transform: `translateY(calc(-50% + ${labelDy[d.name] ?? 0}px))`,
                        fontSize: "9.5px",
                        letterSpacing: "0.02em",
                        color: labelColor,
                        // Dark halo so a label stays legible over dots and any
                        // neighbouring label it sits near.
                        textShadow: "0 0 4px var(--bg), 0 0 6px var(--bg)",
                        ...(d.labelRight
                          ? { left: offset }
                          : { right: offset, textAlign: "right" as const }),
                      }}
                    >
                      {d.name}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>

          {/* X-axis caption */}
          <div className="flex justify-between items-center" style={{ padding: "9px 2px 0" }}>
            <span className="font-mono text-[9px]" style={{ color: "var(--dim)", letterSpacing: "0.1em" }}>low</span>
            <span className="font-mono text-[10px] uppercase" style={{ color: "var(--muted)", letterSpacing: "0.2em" }}>conviction →</span>
            <span className="font-mono text-[9px]" style={{ color: "var(--dim)", letterSpacing: "0.1em" }}>high</span>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        className="flex items-center flex-wrap gap-x-7 gap-y-3 pt-[14px] mt-2"
        style={{ borderTop: `1px solid ${GRIDLINE}` }}
      >
        <div className="flex items-center gap-[10px]">
          <div className="flex items-center gap-[6px]">
            <div className="rounded-full" style={{ width: 7, height: 7, background: NEUTRAL_DOT }} />
            <div className="rounded-full" style={{ width: 14, height: 14, background: NEUTRAL_DOT }} />
          </div>
          <span className="font-mono text-[9px]" style={{ color: "var(--muted)", letterSpacing: "0.06em" }}>
            dot size = obscurity (bigger = deeper)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-full" style={{ width: 11, height: 11, background: "var(--accent)", boxShadow: "0 0 10px rgba(184,131,46,0.6)" }} />
          <span className="font-mono text-[9px]" style={{ color: "var(--muted)", letterSpacing: "0.06em" }}>
            gold = dual-signal find
          </span>
        </div>
        <span className="font-mono text-[9px]" style={{ color: "var(--dim)", letterSpacing: "0.06em" }}>
          hover a dot for its name
        </span>
      </div>
    </div>
  );
}
