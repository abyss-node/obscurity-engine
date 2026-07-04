"use client";

import { useCallback, useRef, useState } from "react";
import { classifyDiscoveryError, TIMEOUT_ERROR, NETWORK_ERROR } from "./discoveryError";
import type { DiscoveryData } from "./types";

export type CompareStatus = "idle" | "loading" | "error" | "success";

/**
 * Visitor-side discovery fetch for the share page's "compare with a friend"
 * feature. Deliberately a much smaller state machine than useDiscovery.ts —
 * no localStorage cache (a comparison run is a one-off, not something we'd
 * want served stale), no retry-trigger/force-fresh knobs (there's no "refresh"
 * affordance on this panel), no run_id/persistence threading (nothing here is
 * ever saved). Mirrors useDiscovery.ts's endpoint construction, 90s timeout +
 * single automatic retry on a transient network drop, and
 * classifyDiscoveryError-based error copy exactly, so a visitor sees the same
 * [ERR] strings a logged-in run would produce for the same failure.
 */
export function useCompare() {
  const [status, setStatus] = useState<CompareStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DiscoveryData | null>(null);
  // Guards against a slow in-flight request's result landing after a newer
  // one started (or after the caller has moved on) — only the latest call's
  // resolution is allowed to write state.
  const requestIdRef = useRef(0);

  const compare = useCallback(async (username: string, period: string, appetite: string) => {
    const requestId = ++requestIdRef.current;
    setStatus("loading");
    setError(null);
    setData(null);

    const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
    // period/appetite come from a STORED share payload (foreign data, only
    // shape-validated), not typed app state like useDiscovery's — encode them
    // so a crafted payload can't smuggle extra query params into the
    // visitor's request.
    const endpoint = `${apiUrl}/api/discovery?username=${encodeURIComponent(username)}&period=${encodeURIComponent(period)}&appetite=${encodeURIComponent(appetite)}`;

    // One automatic retry on a transient network drop — mirrors
    // useDiscovery.ts's fetchDiscovery exactly (see the comment there): never
    // auto-retries a 90s timeout, only a network-level throw.
    const fetchDiscovery = async (): Promise<Response> => {
      try {
        return await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") throw err;
        await new Promise((r) => setTimeout(r, 2000));
        return await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
      }
    };

    try {
      const response = await fetchDiscovery();
      if (requestId !== requestIdRef.current) return; // superseded by a newer call

      if (!response.ok) {
        let detail: string | null = null;
        try {
          const body = await response.json();
          if (body?.error) detail = String(body.error);
        } catch { /* non-JSON */ }
        setError(classifyDiscoveryError(response.status, detail));
        setStatus("error");
        return;
      }

      const json: DiscoveryData = await response.json();
      if (requestId !== requestIdRef.current) return;
      setData(json);
      setStatus("success");
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
      setError(isTimeout ? TIMEOUT_ERROR : NETWORK_ERROR);
      setStatus("error");
    }
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current++;
    setStatus("idle");
    setError(null);
    setData(null);
  }, []);

  return { status, error, data, compare, reset };
}
