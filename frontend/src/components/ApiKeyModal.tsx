"use client";

import { useState } from "react";
import { motion } from "framer-motion";

interface ApiKeyModalProps {
  initialValue: string;
  onSave: (key: string, share: boolean) => void;
  onClose: () => void;
}

// Rate-limit escape hatch (§8). Modal over the dimmed app. By default the key is
// stored in localStorage and only ever sent straight to Last.fm. The opt-in
// "share" toggle additionally contributes it to a shared rotation pool on our
// server to speed up discovery for everyone.
export default function ApiKeyModal({ initialValue, onSave, onClose }: ApiKeyModalProps) {
  const [value, setValue] = useState(initialValue);
  const [share, setShare] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center px-6"
      style={{ background: "rgba(6,6,4,0.82)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 12, opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border p-6 flex flex-col gap-4"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
            api key
          </span>
          <button
            onClick={onClose}
            className="font-mono text-[12px] transition-opacity hover:opacity-60"
            style={{ color: "var(--dim)" }}
            aria-label="close"
          >
            ✕
          </button>
        </div>

        <p className="font-body text-[14px] leading-relaxed" style={{ color: "var(--muted)" }}>
          Your own Last.fm key avoids the shared rate limit. Get one at{" "}
          <a
            href="https://www.last.fm/api/account/create"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-opacity hover:opacity-60"
            style={{ color: "var(--accent)" }}
          >
            last.fm/api →
          </a>{" "}
          (app name anything, callback blank, copy the 32-character key).
        </p>

        <input
          autoFocus
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          className="bg-transparent border-b py-2 font-mono text-[12px] outline-none transition-colors duration-200"
          style={{ borderColor: "var(--border)", color: "var(--text)", caretColor: "var(--accent)" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave(value.trim(), share);
          }}
        />

        {/* Opt-in: contribute the key to the shared rotation pool. */}
        <button
          type="button"
          onClick={() => setShare((s) => !s)}
          className="flex items-start gap-2.5 text-left transition-opacity hover:opacity-80"
        >
          <span
            className="mt-[1px] shrink-0 flex items-center justify-center font-mono text-[10px]"
            style={{
              width: 15, height: 15, border: "1px solid var(--accent2)",
              color: "var(--accent)",
              background: share ? "var(--accent)" : "transparent",
            }}
            aria-hidden
          >
            {share ? "✓" : ""}
          </span>
          <span className="font-mono text-[10px] leading-relaxed tracking-wide" style={{ color: "var(--muted)" }}>
            share this key to speed up discovery for everyone — it joins a pool
            that spreads Last.fm&apos;s rate limit. It&apos;s a read-only app key
            (no account access). Leave off to keep it private to this browser.
          </span>
        </button>

        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] tracking-wider" style={{ color: "var(--dim)" }}>
            {share ? "stored locally + shared to the pool" : "stored locally · never sent to us"}
          </span>
          <button
            onClick={() => onSave(value.trim(), share)}
            className="font-mono text-[10px] tracking-widest px-5 py-2 border transition-colors duration-150"
            style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--accent-bright)";
              e.currentTarget.style.color = "var(--accent-bright)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--accent)";
              e.currentTarget.style.color = "var(--accent)";
            }}
          >
            {value.trim() ? "save" : "clear"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
