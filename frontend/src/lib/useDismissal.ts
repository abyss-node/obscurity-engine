"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { postEvent } from "./events";

// Surface spec: dismiss collapses the card with a 5s inline undo row, then
// backfills from the rest of the already-fetched batch (up to 25 items).
export const UNDO_WINDOW_MS = 5000;

export interface DismissableItem {
  name: string;
  rec_id?: string | null;
}

interface UseDismissalOptions {
  runId?: string | null;
  /** Overridable for tests; defaults to window.setTimeout/clearTimeout. */
  scheduler?: {
    set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (id: ReturnType<typeof setTimeout>) => void;
  };
}

export interface UseDismissalResult<T extends DismissableItem> {
  /** `items` minus anything whose 5s undo window has elapsed. Pending
   *  (not-yet-confirmed) dismissals stay in this array so the caller can
   *  render their undo row in place — backfill only happens once an item
   *  is confirmed and drops out of this list. */
  visible: T[];
  /** Names currently showing the inline undo row. */
  pending: Set<string>;
  dismiss: (item: T) => void;
  undo: (item: T) => void;
}

export function useDismissal<T extends DismissableItem>(
  items: T[],
  opts: UseDismissalOptions = {}
): UseDismissalResult<T> {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const scheduler = opts.scheduler ?? { set: setTimeout, clear: clearTimeout };

  const dismiss = useCallback(
    (item: T) => {
      if (!item.rec_id) return; // gated by capability checks upstream too
      setPending((p) => new Set(p).add(item.name));
      void postEvent({ rec_id: item.rec_id, run_id: opts.runId ?? undefined, type: "dismiss" });

      const existing = timers.current.get(item.name);
      if (existing) scheduler.clear(existing);
      const t = scheduler.set(() => {
        setPending((p) => {
          const next = new Set(p);
          next.delete(item.name);
          return next;
        });
        setConfirmed((c) => new Set(c).add(item.name));
        timers.current.delete(item.name);
      }, UNDO_WINDOW_MS);
      timers.current.set(item.name, t);
    },
    [opts.runId, scheduler]
  );

  const undo = useCallback(
    (item: T) => {
      const t = timers.current.get(item.name);
      if (t) {
        scheduler.clear(t);
        timers.current.delete(item.name);
      }
      setPending((p) => {
        const next = new Set(p);
        next.delete(item.name);
        return next;
      });
      void postEvent({ rec_id: item.rec_id ?? undefined, run_id: opts.runId ?? undefined, type: "undo_dismiss" });
    },
    [opts.runId, scheduler]
  );

  const visible = useMemo(() => items.filter((i) => !confirmed.has(i.name)), [items, confirmed]);

  return { visible, pending, dismiss, undo };
}
