"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface LoadingStateProps {
  wakingUp?: boolean;
}

const PHASES = [
  "fetching scrobble history",
  "building similarity graph",
  "cross-validating genre tags",
  "ranking candidates",
];

export default function LoadingState({ wakingUp }: LoadingStateProps) {
  const [phase, setPhase] = useState(0);
  const [blink, setBlink] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setBlink((b) => !b), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div
      key="loading"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center justify-center gap-7 pt-40 px-6 text-center"
    >
      {/* Scan track */}
      <div className="relative h-px overflow-hidden" style={{ width: 240, background: "var(--border)" }}>
        <motion.div
          initial={{ left: "-42%" }}
          animate={{ left: "100%" }}
          transition={{ repeat: Infinity, duration: 1.9, ease: "linear" }}
          className="absolute inset-y-0"
          style={{
            width: "42%",
            background: "linear-gradient(to right, transparent, var(--accent), transparent)",
          }}
        />
      </div>

      <p className="font-body italic text-xl" style={{ color: "var(--text)" }}>
        Analyzing your library
      </p>

      <p className="font-mono text-[11px] tracking-wider" style={{ color: "var(--accent)" }}>
        {PHASES[phase]}
        <span style={{ opacity: blink ? 1 : 0 }}>_</span>
      </p>

      <p className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
        first run can take ~20s while the engine wakes up
      </p>
    </motion.div>
  );
}
