"use client";

import { motion } from "framer-motion";

interface EmptyStateProps {
  // "fresh" = account exists but has 0 scrobbles (activeSeedCount === 0).
  // "short-window" = there's history, but the selected period had no signal.
  // "saved-empty" = logged in, Saved view, zero saved artists yet.
  variant: "fresh" | "short-window" | "saved-empty";
  // Human-readable window phrase for short-window ("7-day window", "all-time").
  windowLabel?: string;
  // fresh-account actions
  onCheckSetup?: () => void;
  onCheckAgain?: () => void;
}

export default function EmptyState({
  variant,
  windowLabel,
  onCheckSetup,
  onCheckAgain,
}: EmptyStateProps) {
  if (variant === "saved-empty") {
    return (
      <motion.div
        key="empty-saved"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex flex-col items-center justify-center gap-4 pt-24 px-8 text-center"
      >
        <span
          className="font-mono text-[10px] tracking-[0.18em] uppercase"
          style={{ color: "var(--dim)" }}
        >
          nothing saved yet
        </span>
        <p
          className="font-body text-[18px] italic leading-[1.4] max-w-[34ch]"
          style={{ color: "var(--muted)" }}
        >
          Expand an artist card and use &ldquo;save&rdquo; to keep it here.
        </p>
      </motion.div>
    );
  }

  if (variant === "fresh") {
    return (
      <motion.div
        key="empty-fresh"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex flex-col items-center justify-center gap-[22px] pt-40 px-8 text-center"
      >
        <span
          className="font-mono text-[10px] tracking-[0.18em] uppercase"
          style={{ color: "var(--dim)" }}
        >
          account found · 0 scrobbles
        </span>
        <p
          className="font-body text-[22px] italic leading-[1.4] max-w-[34ch]"
          style={{ color: "var(--text)" }}
        >
          Your account is connected, but there&apos;s nothing to map yet.
        </p>
        <p
          className="font-mono text-[11px] tracking-[0.04em] leading-[1.75] max-w-[46ch]"
          style={{ color: "var(--muted)" }}
        >
          The engine needs a few days of listening to read your taste. Keep
          playing music with scrobbling on, then come back —{" "}
          <span style={{ color: "var(--accent)" }}>~50 plays</span> is enough to
          get a first map.
        </p>
        <div className="flex items-center gap-[18px] mt-1">
          {onCheckSetup && (
            <button
              onClick={onCheckSetup}
              className="font-mono text-[10px] tracking-[0.16em] uppercase px-5 py-[9px] border transition-colors duration-150"
              style={{ borderColor: "var(--accent2)", color: "var(--accent)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-bright)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--accent)")}
            >
              check my setup
            </button>
          )}
          {onCheckAgain && (
            <button
              onClick={onCheckAgain}
              className="font-mono text-[10px] tracking-[0.14em] transition-opacity duration-150 hover:opacity-70"
              style={{ color: "var(--dim)" }}
            >
              ↻ check again
            </button>
          )}
        </div>
      </motion.div>
    );
  }

  // short-window
  return (
    <motion.div
      key="empty-short-window"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center justify-center gap-5 pt-40 px-8 text-center"
    >
      <span
        className="font-mono text-[10px] tracking-[0.18em] uppercase"
        style={{ color: "var(--dim)" }}
      >
        no signal · {windowLabel ?? "this window"}
      </span>
      <p
        className="font-body text-[20px] italic leading-[1.45] max-w-[36ch]"
        style={{ color: "var(--text)" }}
      >
        Not enough listening in this window to map anything.
      </p>
      <p
        className="font-mono text-[11px] tracking-[0.06em] leading-[1.7] max-w-[40ch]"
        style={{ color: "var(--muted)" }}
      >
        Try <span style={{ color: "var(--accent)" }}>BLEND</span> or{" "}
        <span style={{ color: "var(--accent)" }}>ALL</span> — they draw on your
        whole history and have the most to work from.
      </p>
    </motion.div>
  );
}
