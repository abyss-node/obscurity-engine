"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDepthProse } from "./scoring";
import { loadCache, saveCache } from "./cache";
import type {
  Artist,
  TrackItem,
  GenreWeight,
  DiscoveryData,
  TrackDiscoveryData,
  DiscoveryMode,
} from "./types";

/**
 * The discovery fetch state machine, extracted verbatim out of app/page.tsx:
 * localStorage cache-first lookup, force-fresh retry, a 90s AbortSignal with a
 * single automatic retry on a transient network drop, [ERR]-prefixed error
 * mapping (including the busy/rate-limit heuristic), and the cold-start
 * "waking up" 3s timer. run_id/persistence thread straight from the response
 * per the Phase 1-B persistence contract.
 *
 * State ownership + setters are exposed directly (not just derived values)
 * because the coordinator (Home) still needs to imperatively clear/reset
 * pieces of this state from outside the fetch effect itself — e.g. the
 * landing-view submit handler pre-clears artists/topGenres before setting
 * username, and handleReset clears the full discovery result set on
 * "go back". This mirrors exactly what page.tsx did with its own useState
 * calls before the move; no behavior changes.
 */
export function useDiscovery(
  username: string | null,
  period: string,
  appetite: string,
  mode: DiscoveryMode,
  apiKey: string,
  // selectedGeoTags lives in the coordinator (it feeds the geo-tag filter
  // memo alongside sortBy, neither of which are part of the fetch state
  // machine) but the original effect reset it to [] on every fetch — this
  // callback preserves that exact reset, at the exact same point in the
  // effect, without pulling unrelated UI-filter state into this hook.
  resetGeoTags: () => void
) {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [tracks, setTracks] = useState<TrackItem[]>([]);
  const [topGenres, setTopGenres] = useState<GenreWeight[]>([]);
  const [activeSeedCount, setActiveSeedCount] = useState(0);
  const [depthScore, setDepthScore] = useState(0);
  const [lowDataMessage, setLowDataMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wakingUp, setWakingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [persistence, setPersistence] = useState(false);

  // NOTE: lastFetchedUsernameRef is written on every fetch but never read
  // anywhere in the original page.tsx — preserved as dead code during the
  // move (no logic edits), flagged in the refactor report as a pre-existing
  // bug/dead-code candidate for a follow-up cleanup, not fixed here.
  const lastFetchedUsernameRef = useRef<string | null>(null);
  const forceFreshRef = useRef(false);

  const applyData = useCallback((data: DiscoveryData | TrackDiscoveryData, m: DiscoveryMode) => {
    if (m === "tracks") {
      const d = data as TrackDiscoveryData;
      setTracks(d.tracks || []);
      setTopGenres(d.top_genres || []);
      setActiveSeedCount(d.active_seed_count || 0);
      setDepthScore(d.depth_score ?? 0);
      setLowDataMessage(d.message ?? null);
    } else {
      const d = data as DiscoveryData;
      setArtists(d.artists || []);
      setTopGenres(d.top_genres || []);
      setActiveSeedCount(d.active_seed_count || 0);
      setDepthScore(d.depth_score ?? 0);
      setLowDataMessage(d.message ?? null);
      setRunId(d.run_id ?? null);
      setPersistence(d.persistence === true);
    }
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      if (!username) return;

      const isForceFresh = forceFreshRef.current;
      forceFreshRef.current = false;

      setError(null);
      setLowDataMessage(null);
      resetGeoTags();
      lastFetchedUsernameRef.current = username;

      // Serve from cache when fresh and not a forced retry
      if (!isForceFresh) {
        const cached = loadCache<DiscoveryData | TrackDiscoveryData>(username, period, mode, appetite);
        if (cached) {
          if (mode === "tracks") setArtists([]);
          else setTracks([]);
          applyData(cached, mode);
          setLoading(false);
          return;
        }
      }

      setArtists([]);
      setTracks([]);
      setTopGenres([]);
      setDepthScore(0);
      setLoading(true);
      setWakingUp(false);
      const wakeupTimer = setTimeout(() => setWakingUp(true), 3000);
      try {
        const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
        const keyParam = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
        const endpoint = mode === "tracks"
          ? `${apiUrl}/api/discovery/tracks?username=${encodeURIComponent(username)}&period=${period}${keyParam}`
          : `${apiUrl}/api/discovery?username=${encodeURIComponent(username)}&period=${period}&appetite=${appetite}${keyParam}`;
        // One automatic retry on a transient network drop (connection reset,
        // brief backend restart). New users on flaky mobile connections were
        // hitting a one-off "couldn't reach" that a manual retry fixed. We do
        // NOT auto-retry a 90s timeout (that would just double the wait).
        const fetchDiscovery = async (): Promise<Response> => {
          try {
            return await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") throw err;
            await new Promise((r) => setTimeout(r, 2000));
            return await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
          }
        };
        const response = await fetchDiscovery();
        if (!response.ok) {
          let detail = `HTTP ${response.status}`;
          let hasAppErrorDetail = false;
          try {
            const body = await response.json();
            if (body?.error) {
              detail = String(body.error);
              hasAppErrorDetail = true;
            }
          } catch { /* non-JSON */ }
          // The backend's only 404 on this endpoint is "no such Last.fm user" —
          // a permanent, non-retryable state. Must be checked before the busy
          // heuristic below: a nonexistent username's error text can otherwise
          // coincidentally match the rate-limit wording and get mislabeled as a
          // transient failure (it isn't — retrying won't help). But a 404 can
          // also come from a framework/proxy layer (misrouted request, wrong
          // API base) whose body isn't the app's error JSON at all — that must
          // NOT be confidently reported as "this username doesn't exist", so
          // USER_NOT_FOUND requires the app's actual error shape (a parseable
          // JSON body carrying an `error` field); an unparseable/bodyless 404
          // falls through to the generic failure copy below instead.
          if (response.status === 404 && hasAppErrorDetail) {
            setError(`[ERR] USER_NOT_FOUND — ${detail}`);
            return;
          }
          // Upstream rate-limit / busy signatures from the backend → actionable hint
          // instead of a raw "error decoding response body".
          const busy =
            response.status >= 500 &&
            /rate limit|error decoding|failed to fetch|temporarily|unavailable/i.test(detail);
          const errMsg = busy
            ? "[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry."
            : response.status >= 500
              ? `[ERR] SONAR_FAILURE — The discovery service hit an error; retry in a moment. (${detail})`
              : `[ERR] SONAR_FAILURE — ${detail}`;
          setError(errMsg);
          return;
        }
        if (mode === "tracks") {
          const data: TrackDiscoveryData = await response.json();
          applyData(data, mode);
          saveCache(username, period, mode, appetite, data);
        } else {
          const data: DiscoveryData = await response.json();
          applyData(data, mode);
          saveCache(username, period, mode, appetite, data);
        }
      } catch (e) {
        const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
        setError(
          isTimeout
            ? "[ERR] SONAR_FAILURE — Request timed out after 90s. The service may be busy; retry."
            : "[ERR] SONAR_FAILURE — Couldn't reach the discovery service. It may be starting up or blocked; retry in a moment."
        );
      } finally {
        clearTimeout(wakeupTimer);
        setWakingUp(false);
        setLoading(false);
      }
    };
    // Tracks discovery is gated behind a "Coming soon" overlay for alpha — don't
    // spend Last.fm rate limit fetching a mode users can't see yet.
    if (mode === "tracks") {
      setLoading(false);
    } else {
      fetchData();
    }
    // resetGeoTags must be a referentially-stable callback (useCallback with
    // an empty dep array) on the caller's side — same contract as applyData
    // above — so adding it here doesn't change when this effect re-runs.
  }, [username, period, appetite, mode, fetchTrigger, applyData, resetGeoTags]);

  const retry = useCallback(() => {
    forceFreshRef.current = true;
    setFetchTrigger((t) => t + 1);
  }, []);

  const resultCount = mode === "tracks" ? tracks.length : artists.length;
  const isInitialLoad = loading && resultCount === 0;
  const isRefreshing = loading && resultCount > 0;

  const depthProse =
    depthScore > 0
      ? getDepthProse(
          depthScore,
          topGenres[0]?.weight > 10 ? topGenres[0]?.name : undefined
        )
      : null;

  return {
    artists,
    setArtists,
    tracks,
    setTracks,
    topGenres,
    setTopGenres,
    activeSeedCount,
    depthScore,
    setDepthScore,
    lowDataMessage,
    loading,
    wakingUp,
    error,
    setError,
    runId,
    setRunId,
    persistence,
    setPersistence,
    resultCount,
    isInitialLoad,
    isRefreshing,
    depthProse,
    retry,
  };
}
