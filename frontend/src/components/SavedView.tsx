"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fetchSaved, type SavedArtist } from "@/lib/me";
import { postEvent } from "@/lib/events";
import EmptyState from "./EmptyState";
import ErrorState from "./ErrorState";

interface SavedViewProps {
  onClose: () => void;
  /** Reconciles the top-bar saved count with the backend truth once loaded. */
  onCountChange?: (count: number) => void;
}

type Status = "loading" | "loaded" | "empty" | "error";

// Minimal full-page panel — reuses the house EmptyState/ErrorState patterns
// per the Saved-view surface spec rather than inventing bespoke states.
export default function SavedView({ onClose, onCountChange }: SavedViewProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [items, setItems] = useState<SavedArtist[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetchSaved()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setStatus(list.length === 0 ? "empty" : "loaded");
        onCountChange?.(list.length);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "couldn't load saved artists");
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  const handleRemove = async (item: SavedArtist) => {
    // Optimistic removal; a failed unsave puts the row back.
    const withoutItem = items.filter((i) => i.rec_id !== item.rec_id);
    setItems(withoutItem);
    const ok = await postEvent({ rec_id: item.rec_id, type: "unsave" });
    if (!ok) {
      setItems((prev) => [...prev, item]);
      return;
    }
    onCountChange?.(withoutItem.length);
    if (withoutItem.length === 0) setStatus("empty");
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] overflow-y-auto"
      style={{ background: "var(--bg)" }}
    >
      <div className="max-w-2xl mx-auto px-6 py-16 flex flex-col gap-10">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
            saved
          </span>
          <button
            onClick={onClose}
            className="font-mono text-[11px] tracking-widest transition-opacity duration-150 hover:opacity-60"
            style={{ color: "var(--muted)" }}
          >
            close ✕
          </button>
        </div>

        {status === "loading" && (
          <div className="flex flex-col items-center gap-4 pt-20">
            <div className="relative h-px overflow-hidden" style={{ width: 180, background: "var(--border)" }}>
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
            <p className="font-mono text-[11px] tracking-wider" style={{ color: "var(--muted)" }}>
              loading saved artists...
            </p>
          </div>
        )}

        {status === "error" && (
          <ErrorState error={error ?? "couldn't load saved artists"} onRetry={() => setReloadTick((t) => t + 1)} />
        )}

        {status === "empty" && <EmptyState variant="saved-empty" />}

        {status === "loaded" && (
          <div className="flex flex-col">
            {items.map((item) => (
              <div
                key={item.rec_id}
                className="flex items-center justify-between gap-4 border-b py-4"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[12px] leading-none shrink-0" style={{ color: "var(--text)" }} aria-hidden>
                    ●
                  </span>
                  <span className="font-serif text-[18px] font-semibold truncate" style={{ color: "var(--text)" }}>
                    {item.artist_name}
                  </span>
                </div>
                <button
                  onClick={() => handleRemove(item)}
                  className="font-mono text-[10px] tracking-widest shrink-0 transition-opacity duration-150 hover:opacity-60"
                  style={{ color: "var(--dim)" }}
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
