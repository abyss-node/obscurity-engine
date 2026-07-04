"use client";

import { motion } from "framer-motion";

interface ErrorStateProps {
  error: string;
  onRetry: () => void;
  onAddApiKey?: () => void;
}

export default function ErrorState({ error, onRetry, onAddApiKey }: ErrorStateProps) {
  // The app prefixes messages with "[ERR] CODE — "; pull the code out for the
  // header (defaulting to REQUEST_FAILED for untagged/legacy strings) and
  // strip the token from the prose so we don't double-label under the header.
  const match = error.match(/^\[ERR\]\s+([A-Z_]+)\s+[—-]\s+([\s\S]*)$/);
  const code = match ? match[1] : "REQUEST_FAILED";
  const prose = (match ? match[2] : error).trim();
  const isUserNotFound = code === "USER_NOT_FOUND";
  // A nonexistent username is permanent, not transient — the fallback copy
  // must not suggest waiting/retrying will help.
  const fallbackProse = isUserNotFound
    ? "That username doesn't exist. Check the spelling and try again."
    : "Something went wrong reaching the discovery service. It may be rate-limited or waking up — wait a moment and retry.";

  return (
    <motion.div
      key="error"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center justify-center gap-6 pt-40 px-6 text-center"
    >
      <span className="font-mono text-[11px] tracking-widest" style={{ color: "var(--discovery)" }}>
        [ERR] {code}
      </span>
      <p
        className="font-body text-[15px] leading-relaxed max-w-md"
        style={{ color: "var(--muted)" }}
      >
        {prose || fallbackProse}
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={onRetry}
          className="font-mono text-[10px] tracking-widest px-5 py-2 border transition-opacity duration-150 hover:opacity-70"
          style={{ borderColor: "var(--discovery)", color: "var(--discovery)" }}
        >
          ↻ retry
        </button>
        {onAddApiKey && (
          <button
            onClick={onAddApiKey}
            className="font-mono text-[10px] tracking-widest px-5 py-2 border transition-opacity duration-150 hover:opacity-70"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            add API key
          </button>
        )}
      </div>
    </motion.div>
  );
}
