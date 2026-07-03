"use client";

// Replaces an ArtistCard in place for its 5s undo window (Surface spec:
// "dismiss collapses the card with a 5s inline undo row"). ArtistList swaps
// this in for the pending item; the surrounding motion.div's `layout`
// animation gives the collapse its height transition.
export default function DismissedRow({ name, onUndo }: { name: string; onUndo: () => void }) {
  return (
    <div
      className="border-b flex items-center justify-between px-3 py-3.5"
      style={{ borderColor: "var(--border)" }}
    >
      <span className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
        dismissed <span style={{ color: "var(--muted)" }}>{name}</span>
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
        style={{ color: "var(--accent)" }}
      >
        undo
      </button>
    </div>
  );
}
