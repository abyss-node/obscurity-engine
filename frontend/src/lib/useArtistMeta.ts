"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ArtistMeta } from "./types";
import { fetchArtistMeta, metaRequestNames } from "./artistMeta";

// Delays before re-polls while names are pending: initial request, then
// 2s, 4s, 8s, 8s — five requests at most.
export const POLL_DELAYS_MS = [2000, 4000, 8000, 8000];

// Session-wide cache of settled answers (a real result or a settled miss).
// Pending names are never stored, so a later mount retries them.
const cache = new Map<string, ArtistMeta | null>();
let version = 0;
let unsupported = false;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const getVersion = () => version;

function commit(entries: Array<[string, ArtistMeta | null]>) {
  if (!entries.length) return;
  for (const [k, v] of entries) cache.set(k, v);
  version++;
  listeners.forEach((l) => l());
}

/** Test seam: forget everything learned this session. */
export function resetArtistMetaCache() {
  cache.clear();
  unsupported = false;
  version++;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

async function resolveNames(apiUrl: string, names: string[], signal: AbortSignal) {
  let waiting = names;
  for (let attempt = 0; attempt <= POLL_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(POLL_DELAYS_MS[attempt - 1], signal);
    }
    if (signal.aborted || unsupported) return;
    const result = await fetchArtistMeta(apiUrl, waiting, signal);
    if (signal.aborted) return;
    if (result.kind === "unsupported") { unsupported = true; return; }
    if (result.kind === "error") return;
    const { meta, pending } = result.data;
    const stillPending = new Set(pending);
    const settled: Array<[string, ArtistMeta | null]> = [];
    const next: string[] = [];
    for (const n of waiting) {
      const m = meta[n] ?? null;
      if (m) settled.push([n, m]);
      else if (stillPending.has(n)) next.push(n);
      else settled.push([n, null]);
    }
    commit(settled);
    if (!next.length) return;
    waiting = next;
  }
}

/**
 * Fetch MusicBrainz origin facts for the shown artist names, after results
 * render. Returns a lookup; undefined means "not known (yet)". Fails open:
 * any error or a backend without the endpoint just yields no meta.
 */
export function useArtistMeta(names: string[]): (name: string) => ArtistMeta | null | undefined {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const key = JSON.stringify(metaRequestNames(names));

  useEffect(() => {
    if (unsupported) return;
    const missing = (JSON.parse(key) as string[]).filter((n) => !cache.has(n));
    if (!missing.length) return;
    const ctrl = new AbortController();
    const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
    void resolveNames(apiUrl, missing, ctrl.signal);
    return () => ctrl.abort();
  }, [key]);

  return useCallback((name: string) => cache.get(name), []);
}
