"use client";

import { useEffect, useState } from "react";
import { useCompare } from "../lib/useCompare";
import { computeComparison } from "../lib/compare";
import { formatListeners } from "../lib/scoring";
import type { Artist } from "../lib/types";

interface CompareSectionProps {
  sharerUsername: string;
  period: string;
  appetite: string;
  sharerArtists: Artist[];
}

/**
 * "Compare with a friend" growth hook on the `/r/[id]` share page. A visitor
 * types their own Last.fm username, we run their discovery with the same
 * period/appetite as the share, and render a taste-match panel against the
 * sharer's saved recommendations. Kept as its own component (rather than
 * inline in ReadonlyResults) so it's independently testable and so the
 * self-guard / loading / error / success states stay easy to reason about.
 */
export default function CompareSection({
  sharerUsername,
  period,
  appetite,
  sharerArtists,
}: CompareSectionProps) {
  const [input, setInput] = useState("");
  const [dots, setDots] = useState(1);
  const { status, error, data, compare, reset } = useCompare();

  const isSelf = input.trim().toLowerCase() === sharerUsername.trim().toLowerCase();
  const loading = status === "loading";

  // Simple animated ellipsis for the long-running (30-60s) fetch — no spinner
  // component in this codebase's vocabulary, mono text ticking 1-3 dots.
  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => setDots((d) => (d % 3) + 1), 500);
    return () => clearInterval(timer);
  }, [loading]);

  const handleCompare = () => {
    const trimmed = input.trim();
    if (!trimmed || isSelf || loading) return;
    void compare(trimmed, period, appetite);
  };

  const comparison =
    status === "success" && data ? computeComparison(sharerArtists, data) : null;

  const depthVerdict = (() => {
    if (!comparison) return null;
    const { sharerMedianListeners, visitorMedianListeners } = comparison;
    if (visitorMedianListeners === sharerMedianListeners) return "equally deep";
    return visitorMedianListeners < sharerMedianListeners
      ? "you dig deeper"
      : `${sharerUsername} digs deeper`;
  })();

  return (
    <div className="flex flex-col gap-4 pb-8 border-b" style={{ borderColor: "var(--border)" }}>
      <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
        compare — how deep does your taste go?
      </span>

      {status !== "success" && (
        <>
          <p className="font-serif italic text-base sm:text-lg leading-snug" style={{ color: "var(--text)" }}>
            See how your library stacks up against {sharerUsername}&apos;s finds.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (status === "error") reset();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCompare();
              }}
              placeholder="your last.fm username"
              disabled={loading}
              className="obs-input flex-1 min-w-0 px-3 py-2 font-mono text-sm outline-none border transition-colors duration-200"
              style={{
                background: "var(--surface)",
                borderColor: "var(--border)",
                color: "var(--text)",
                caretColor: "var(--accent)",
              }}
            />
            <button
              type="button"
              onClick={handleCompare}
              disabled={loading || !input.trim() || isSelf}
              className="font-mono text-[11px] tracking-widest px-5 py-2 border shrink-0 transition-opacity duration-150 hover:opacity-70 disabled:opacity-40"
              style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            >
              compare →
            </button>
          </div>

          {isSelf && input.trim() && (
            <p className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
              that&apos;s the username being shared — try a different one to compare.
            </p>
          )}

          {loading && (
            <p className="font-mono text-[11px] tracking-wider" style={{ color: "var(--muted)" }}>
              scanning your library{".".repeat(dots)}
            </p>
          )}

          {status === "error" && error && (
            <p className="font-mono text-[11px] tracking-wider" style={{ color: "var(--discovery)" }}>
              {error}
            </p>
          )}
        </>
      )}

      {comparison && data && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span
              className="font-serif text-4xl sm:text-5xl font-bold italic leading-none"
              style={{ color: "var(--text)" }}
            >
              {comparison.tasteMatch}% taste match
            </span>
            <span className="font-mono text-[11px] tracking-widest" style={{ color: "var(--muted)" }}>
              {depthVerdict}
            </span>
            <span className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
              you: {comparison.visitorMedianListeners.toLocaleString()} median listeners ·{" "}
              {sharerUsername}: {comparison.sharerMedianListeners.toLocaleString()} median listeners
            </span>
          </div>

          {data.message && (
            <p className="font-mono text-[10px] tracking-wider leading-relaxed" style={{ color: "var(--dim)" }}>
              {data.message}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {comparison.overlap.length > 0 ? (
              <>
                <span
                  className="font-mono text-[10px] tracking-widest uppercase"
                  style={{ color: "var(--dim)" }}
                >
                  you&apos;d both discover
                </span>
                <div className="flex flex-wrap gap-2">
                  {comparison.overlap.map((artist) => (
                    <div
                      key={artist.name}
                      className="flex flex-col gap-0.5 px-3 py-2 border"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <span className="font-mono text-[11px]" style={{ color: "var(--text)" }}>
                        {artist.name}
                      </span>
                      <span className="font-mono text-[9px] tracking-wider" style={{ color: "var(--dim)" }}>
                        {formatListeners(artist.total_listeners)} listeners
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="font-mono text-[11px] tracking-wider" style={{ color: "var(--muted)" }}>
                zero overlap — completely different rabbit holes
              </p>
            )}
          </div>

          <a
            href="/"
            className="font-mono text-[11px] tracking-widest w-fit transition-opacity duration-200 hover:opacity-60"
            style={{ color: "var(--accent)" }}
          >
            run your full scan →
          </a>
        </div>
      )}
    </div>
  );
}
