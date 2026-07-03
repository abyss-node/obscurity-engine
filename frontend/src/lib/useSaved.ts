"use client";

import { useCallback, useState } from "react";
import { postEvent } from "./events";
import type { DismissableItem } from "./useDismissal";

/**
 * Optimistic local save/unsave toggle for the current result set. Rolls back
 * on a failed POST /api/events so the UI never claims a save that didn't
 * persist. `onCountChange` bubbles a +1/-1 delta up so the top-bar "saved"
 * nav item (shown only when the user has >=1 save) can stay in sync without
 * refetching /api/me/saved on every click.
 */
export function useSaved(runId?: string | null, onCountChange?: (delta: number) => void) {
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const save = useCallback(
    async (item: DismissableItem) => {
      if (!item.rec_id) return;
      setSaved((s) => new Set(s).add(item.name));
      const ok = await postEvent({ rec_id: item.rec_id, run_id: runId ?? undefined, type: "save" });
      if (!ok) {
        setSaved((s) => {
          const next = new Set(s);
          next.delete(item.name);
          return next;
        });
        return;
      }
      onCountChange?.(1);
    },
    [runId, onCountChange]
  );

  const unsave = useCallback(
    async (item: DismissableItem) => {
      setSaved((s) => {
        const next = new Set(s);
        next.delete(item.name);
        return next;
      });
      const ok = await postEvent({ rec_id: item.rec_id ?? undefined, run_id: runId ?? undefined, type: "unsave" });
      if (!ok) {
        setSaved((s) => new Set(s).add(item.name));
        return;
      }
      onCountChange?.(-1);
    },
    [runId, onCountChange]
  );

  const isSaved = useCallback((name: string) => saved.has(name), [saved]);

  return { save, unsave, isSaved };
}
