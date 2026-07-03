"use client";

import { useEffect, useState } from "react";
import { PERIOD_LABELS, APPETITE_STOPS } from "./types";

// Mirrors useUrlModes' own bootstrap branch detection: the ?u= shared-view
// path and the Spotify OAuth ?code&state callback path both leave period/
// appetite untouched by any *first-pass* localStorage restore (see the
// write-back-race trace in the refactor handoff doc), so the lazy initial
// state below must land on the same pre-restore default ("blend"/
// "balanced") in those two branches — reading localStorage there would
// desync from main's per-path byte parity. Only the plain/normal mount path
// (neither branch) should seed from localStorage directly.
function isSpecialMount(): boolean {
  if (typeof window === "undefined") return true; // SSR: no localStorage; treat as "use default"
  const params = new URLSearchParams(window.location.search);
  const isOAuthCallback = !!(params.get("code") && params.get("state"));
  const isSharedViewUrl = !!params.get("u");
  return isOAuthCallback || isSharedViewUrl;
}

function readInitialPeriod(): string {
  if (isSpecialMount()) return "blend";
  try {
    const saved = localStorage.getItem("obscurity_period");
    if (saved && PERIOD_LABELS[saved]) return saved;
  } catch {
    // localStorage inaccessible (privacy mode, etc.) — fall through to default
  }
  return "blend";
}

function readInitialAppetite(): string {
  if (isSpecialMount()) return "balanced";
  try {
    const saved = localStorage.getItem("obscurity_appetite");
    if (saved && APPETITE_STOPS.some((s) => s.val === saved)) return saved;
  } catch {
    // ignore
  }
  return "balanced";
}

/**
 * Owns period/appetite/api-key state and the localStorage write-back for
 * period + appetite, moved verbatim out of app/page.tsx. The *initial*
 * restore-from-storage (on first mount, only when not in the ?u= shared-view
 * branch) stays in useUrlModes — it's part of one load-bearing, order-
 * sensitive mount effect that's also handling the ?u=/OAuth-callback
 * precedence, so it isn't safe to split out of that effect. This hook's
 * setters are handed to that effect so it can still perform the restore.
 *
 * `username`/`isSharedView` are read-only inputs here (not owned by this
 * hook) purely so the write-back effects can reproduce the exact original
 * gating — same pattern as useSaved/useDismissal taking `runId` as a param.
 */
export function usePersistedPrefs(isSharedView: boolean) {
  const [period, setPeriod] = useState(readInitialPeriod);
  const [appetite, setAppetite] = useState(readInitialAppetite);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");

  useEffect(() => {
    if (!isSharedView) localStorage.setItem("obscurity_period", period);
  }, [period, isSharedView]);

  useEffect(() => {
    if (!isSharedView) localStorage.setItem("obscurity_appetite", appetite);
  }, [appetite, isSharedView]);

  const handleSaveApiKey = (key: string, share = false) => {
    setApiKey(key);
    setApiKeyInput(key);
    if (key) localStorage.setItem("obscurity_api_key", key);
    else localStorage.removeItem("obscurity_api_key");
    // Opt-in: contribute the key to the shared rotation pool. Best-effort —
    // it speeds up discovery for everyone but must never block the user.
    if (share && key) {
      const apiUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
      fetch(`${apiUrl}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      }).catch(() => {});
    }
  };

  return {
    period,
    setPeriod,
    appetite,
    setAppetite,
    apiKey,
    setApiKey,
    apiKeyInput,
    setApiKeyInput,
    handleSaveApiKey,
  };
}
