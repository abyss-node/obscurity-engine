"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ArtistMeta } from "./types";
import { MAX_META_NAMES, fetchArtistMeta, metaRequestNames } from "./artistMeta";

// Delays before re-polls while names are pending: initial request, then
// 2s, 4s, 8s, 8s — five requests at most.
export const POLL_DELAYS_MS = [2000, 4000, 8000];
// Keep polling a name while the backend reports it pending (it resolves them
// serially, 1-2 s each), until this long after the name's first request.
export const POLL_BUDGET_MS = 90_000;

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
  attempts.clear();
  firstRequestAt.clear();
  poller?.ctrl.abort();
  poller = null;
  unsupported = false;
  version++;
}

// One shared poller. Mounted hooks hold references to names; the poller runs
// while any held, uncached name still has requests left, and is aborted (and
// forgotten) synchronously the moment nothing is held, so a new effect can
// always start a fresh one. Names joining mid-poll wake it immediately.
const firstRequestAt = new Map<string, number>();
const holders = new Map<string, number>();
const attempts = new Map<string, number>();
let poller: { ctrl: AbortController; wake: () => void } | null = null;

function eligible(): string[] {
  return [...holders.keys()].filter((n) => !cache.has(n) && Date.now() - (firstRequestAt.get(n) ?? Date.now()) < POLL_BUDGET_MS);
}

function acquire(names: string[]) {
  for (const n of names) holders.set(n, (holders.get(n) ?? 0) + 1);
  if (poller) poller.wake();
  else startPoller();
}

function release(names: string[]) {
  for (const n of names) {
    const left = (holders.get(n) ?? 1) - 1;
    if (left > 0) { holders.set(n, left); continue; }
    holders.delete(n);
    attempts.delete(n);
    firstRequestAt.delete(n);
  }
  if (holders.size === 0 && poller) {
    poller.ctrl.abort();
    poller = null;
  }
}

function startPoller() {
  const ctrl = new AbortController();
  let wake: () => void = () => {};
  const me = { ctrl, wake: () => wake() };
  poller = me;
  const { signal } = ctrl;
  const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
  void (async () => {
    try {
      while (!signal.aborted && !unsupported) {
        const batch = eligible().slice(0, MAX_META_NAMES);
        if (!batch.length) return;
        const now = Date.now();
        batch.forEach((n) => {
          attempts.set(n, (attempts.get(n) ?? 0) + 1);
          if (!firstRequestAt.has(n)) firstRequestAt.set(n, now);
        });
        const result = await fetchArtistMeta(apiUrl, batch, signal);
        if (signal.aborted) return;
        if (result.kind === "unsupported") { unsupported = true; return; }
        if (result.kind === "error") return;
        const { meta, pending } = result.data;
        const stillPending = new Set(pending);
        const settled: Array<[string, ArtistMeta | null]> = [];
        let deepest = 0;
        for (const n of batch) {
          const m = meta[n] ?? null;
          if (m) settled.push([n, m]);
          else if (stillPending.has(n)) deepest = Math.max(deepest, attempts.get(n) ?? 1);
          else settled.push([n, null]);
        }
        commit(settled);
        if (!eligible().length) return;
        // Back off by the most-retried pending name; a newly acquired name wakes us early.
        const delay = POLL_DELAYS_MS[Math.min(Math.max(deepest, 1), POLL_DELAYS_MS.length) - 1];
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          wake = () => { clearTimeout(t); resolve(); };
          signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        wake = () => {};
      }
    } finally {
      if (poller === me) poller = null;
    }
  })();
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
    return () => release(wanted);
  }, [key]);

  return useCallback((name: string) => cache.get(name), []);
}
