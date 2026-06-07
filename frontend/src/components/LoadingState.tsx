"use client";

import { motion } from "framer-motion";

interface LoadingStateProps {
  wakingUp: boolean;
}

export default function LoadingState({ wakingUp }: LoadingStateProps) {
  return (
    <motion.div
      key="loading"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center justify-center gap-6 pt-40"
    >
      <div
        className="relative w-48 h-px overflow-hidden"
        style={{ background: "var(--border)" }}
      >
        <motion.div
          initial={{ x: "-100%" }}
          animate={{ x: "200%" }}
          transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
          className="absolute inset-y-0 w-1/2"
          style={{
            background: "linear-gradient(to right, transparent, var(--accent), transparent)",
          }}
        />
      </div>
      <p className="font-mono text-[11px] tracking-widest" style={{ color: "var(--muted)" }}>
        calibrating sonar...
      </p>
      {wakingUp && (
        <p
          className="font-mono text-[10px] tracking-wider animate-pulse"
          style={{ color: "var(--dim)" }}
        >
          waking up — this may take a moment
        </p>
      )}
    </motion.div>
  );
}
