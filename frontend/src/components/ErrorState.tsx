"use client";

import { motion } from "framer-motion";

interface ErrorStateProps {
  error: string;
  onRetry: () => void;
}

export default function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <motion.div
      key="error"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center justify-center gap-6 pt-40 px-6"
    >
      <p
        className="font-mono text-[11px] tracking-wider text-center max-w-md leading-loose"
        style={{ color: "var(--discovery)" }}
      >
        {error}
      </p>
      <button
        onClick={onRetry}
        className="font-mono text-[10px] tracking-widest px-6 py-2 border transition-opacity duration-150 hover:opacity-70"
        style={{ borderColor: "var(--discovery)", color: "var(--discovery)" }}
      >
        retry →
      </button>
    </motion.div>
  );
}
