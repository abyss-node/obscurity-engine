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
  holders.clear();
  owner.forEach((c) => c.abort());
  owner.clear();
  unsupported = false;
  version++;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

// In-flight dedupe: a name being polled is owned by one run; every mounted
// hook that wants it holds a reference. A run keeps polling while any holder
// of any of its names remains, so one consumer unmounting never starves another.
const holders = new Map<string, number>();
const owner = new Map<string, AbortController>();

function acquire(names: string[]) {
  for (const n of names) holders.set(n, (holders.get(n) ?? 0) + 1);
}
function release(names: string[]) {
  for (const n of names) {
    const left = (holders.get(n) ?? 1) - 1;
    if (left > 0) { holders.set(n, left); continue; }
    holders.delete(n);
    const ctrl = owner.get(n);
    if (ctrl && ![...owner].some(([k, c]) => c === ctrl && holders.has(k))) ctrl.abort();
  }
}

async function resolveNames(apiUrl: string, names: string[], ctrl: AbortController) {
  const { signal } = ctrl;
  names.forEach((n) => owner.set(n, ctrl));
  let waiting = names;
  try {
    for (let attempt = 0; attempt <= POLL_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(POLL_DELAYS_MS[attempt - 1], signal);
      waiting = waiting.filter((n) => holders.has(n) && !cache.has(n));
      if (signal.aborted || unsupported || !waiting.length) return;
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
  } finally {
    names.forEach((n) => { if (owner.get(n) === ctrl) owner.delete(n); });
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
    const wanted = (JSON.parse(key) as string[]).filter((n) => !cache.has(n));
    if (!wanted.length) return;
    acquire(wanted);
    const unowned = wanted.filter((n) => !owner.has(n));
    if (unowned.length) {
      const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
      void resolveNames(apiUrl, unowned, new AbortController());
    }
    return () => release(wanted);
  }, [key]);

  return useCallback((name: string) => cache.get(name), []);
}
