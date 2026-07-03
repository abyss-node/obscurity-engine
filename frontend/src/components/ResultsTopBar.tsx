"use client";

import { PERIOD_LABELS, APPETITE_STOPS, type DiscoveryMode } from "../app/page";
import type { Session } from "../lib/session";

interface ResultsTopBarProps {
  username: string;
  onReset: () => void;
  mode: DiscoveryMode;
  setMode: (m: DiscoveryMode) => void;
  period: string;
  setPeriod: (p: string) => void;
  appetite: string;
  setAppetite: (a: string) => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
  isRefreshing: boolean;
  shareState: "idle" | "rendering" | "saved" | "copied";
  onShare: () => void;
  session?: Session | null;
  savedCount?: number;
  onShowSaved?: () => void;
  onLogout?: () => void;
}

const SEP = (extraClass = "") => (
  <span
    className={`font-mono text-xs shrink-0 hidden min-[720px]:inline ${extraClass}`}
    style={{ color: "var(--border)" }}
  >
    |
  </span>
);

/**
 * Single-row, contained top bar (results-redesign handoff §1). Replaces the
 * previous fixed 2-row-wrapping bar + a separately floating, overlapping
 * wordmark. `white-space:nowrap; overflow:hidden` so nothing ever paints
 * outside the bar at any width ≥720px; below 720px the original mobile
 * wrap layout is preserved unchanged (every class that affects <720px
 * rendering is left exactly as it was).
 */
export default function ResultsTopBar({
  username,
  onReset,
  mode,
  setMode,
  period,
  setPeriod,
  appetite,
  setAppetite,
  onRefresh,
  refreshDisabled,
  isRefreshing,
  shareState,
  onShare,
  session = null,
  savedCount = 0,
  onShowSaved,
  onLogout,
}: ResultsTopBarProps) {
  const appetiteIdx = Math.max(0, APPETITE_STOPS.findIndex((s) => s.val === appetite));
  const activeAppetite = APPETITE_STOPS[appetiteIdx];

  return (
    <div
      className="fixed top-0 left-0 right-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b min-[720px]:flex-nowrap min-[720px]:h-12 min-[720px]:py-0 min-[720px]:px-4 min-[720px]:overflow-hidden min-[720px]:whitespace-nowrap"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {/* Wordmark — contained in the bar (desktop only; mobile keeps the
          existing username-only "go back" affordance, no wordmark there
          today either — this removes the old floating/overlapping copy).
          Hidden through the 720–849px dead zone (7 period pills + mode
          toggle + slider don't fit alongside it at that width — verified
          empirically, single row resumes cleanly at 850px); reappears at
          ≥850px, comfortably inside the intended ≥720px desktop design. */}
      <button
        type="button"
        onClick={onReset}
        className="hidden min-[850px]:inline-block font-serif text-[13px] font-semibold tracking-wide shrink-0 transition-opacity duration-150 hover:opacity-70"
        style={{ color: "var(--accent)" }}
      >
        OBSCURITY ENGINE
      </button>
      <span
        className="font-mono text-xs shrink-0 hidden min-[850px]:inline"
        style={{ color: "var(--border)" }}
      >
        |
      </span>

      {/* Username — reset on click. Always visible on mobile (unchanged);
          hidden 720–1029px per the degradation spec, back at ≥1030px.
          (Was ≥1000px, which collided with the refresh-label reveal at the
          same breakpoint and tipped the row into a wrap right at 1000px —
          verified empirically; 1030px carries enough margin.) */}
      <button
        onClick={onReset}
        className="font-mono text-[11px] tracking-wide transition-opacity duration-150 hover:opacity-50 shrink-0 min-[720px]:hidden min-[1030px]:inline-block"
        style={{ color: "var(--muted)" }}
      >
        {username}
      </button>
      <span
        className="font-mono text-xs shrink-0 hidden min-[1030px]:inline"
        style={{ color: "var(--border)" }}
      >
        |
      </span>

      {/* Mode toggle */}
      <div className="flex gap-1 shrink-0">
        {(["artists", "tracks"] as DiscoveryMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className="font-mono text-[10px] tracking-wider px-2 py-0.5 border transition-colors duration-150"
            style={{
              borderColor: mode === m ? "var(--accent)" : "var(--border)",
              color: mode === m ? "var(--accent)" : "var(--dim)",
            }}
          >
            {m}
          </button>
        ))}
      </div>

      {SEP()}

      {/* Period pills — own full-width row on mobile, inline (flex-1 filler
          that pushes the appetite/refresh/share cluster to the right) on
          desktop. */}
      <div className="flex flex-wrap gap-1 order-last basis-full min-[720px]:order-none min-[720px]:basis-auto min-[720px]:flex-1 min-[720px]:min-w-0">
        {Object.entries(PERIOD_LABELS).map(([val, label]) => (
          <button
            key={val}
            onClick={() => setPeriod(val)}
            className="font-mono text-[10px] tracking-wider px-2 py-0.5 border transition-colors duration-150"
            style={{
              borderColor: period === val ? "var(--accent)" : "var(--border)",
              color: period === val ? "var(--accent)" : "var(--dim)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {SEP()}

      {/* Discovery appetite slider — own full-width row on mobile (unchanged);
          joins the single row on desktop, shrinking progressively. */}
      <div className="flex items-center gap-2 order-last basis-full min-[720px]:order-none min-[720px]:basis-auto min-[720px]:shrink-0">
        <span
          className="font-mono text-[10px] tracking-wider shrink-0 min-[720px]:hidden min-[1150px]:inline"
          style={{ color: "var(--dim)" }}
        >
          appetite
        </span>
        <input
          type="range"
          min={0}
          max={APPETITE_STOPS.length - 1}
          step={1}
          value={appetiteIdx}
          onChange={(e) => setAppetite(APPETITE_STOPS[Number(e.target.value)].val)}
          className="flex-1 min-w-0 max-w-[220px] min-[720px]:flex-none min-[720px]:w-[90px] min-[1150px]:w-[120px] cursor-pointer"
          style={{ accentColor: "var(--accent)" }}
          aria-label="Discovery appetite"
          title={`${activeAppetite?.label} — ${activeAppetite?.blurb}`}
        />
        <span
          className="font-mono text-[10px] tracking-wider shrink-0 min-[720px]:hidden min-[900px]:inline"
          style={{ color: "var(--accent)" }}
        >
          {activeAppetite?.label}
        </span>
      </div>

      {/* Refresh */}
      <button
        onClick={onRefresh}
        disabled={refreshDisabled}
        className="font-mono text-[10px] tracking-widest shrink-0 transition-opacity duration-150 hover:opacity-60 disabled:opacity-30"
        style={{ color: "var(--dim)" }}
        title="refresh"
      >
        {isRefreshing ? (
          "..."
        ) : (
          <>
            <span aria-hidden>↺</span>
            <span className="min-[720px]:hidden min-[1030px]:inline"> refresh</span>
          </>
        )}
      </button>

      {/* Session display + the quiet "saved" nav item, shown only once the
          user has >=1 save. */}
      {session && (
        <>
          {SEP()}
          <button
            onClick={onLogout}
            className="font-mono text-[10px] tracking-wide shrink-0 transition-opacity duration-150 hover:opacity-60"
            style={{ color: "var(--dim)" }}
            title="log out"
          >
            {session.username}
          </button>
          {savedCount > 0 && (
            <button
              onClick={onShowSaved}
              className="font-mono text-[10px] tracking-wider shrink-0 transition-opacity duration-150 hover:opacity-60"
              style={{ color: "var(--dim)" }}
            >
              saved
            </button>
          )}
        </>
      )}

      {SEP()}

      {/* Share */}
      <button
        onClick={onShare}
        disabled={shareState === "rendering"}
        className="font-mono text-[10px] tracking-widest shrink-0 transition-opacity duration-150 hover:opacity-60 disabled:opacity-40"
        style={{ color: "var(--dim)" }}
        title="share"
      >
        {shareState === "rendering"
          ? "rendering…"
          : shareState === "saved"
            ? "saved ✓"
            : shareState === "copied"
              ? "copied"
              : "↑ share"}
      </button>
    </div>
  );
}
