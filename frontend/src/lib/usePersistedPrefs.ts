"use client";

import { useEffect, useState } from "react";

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
  const [period, setPeriod] = useState("blend");
  const [appetite, setAppetite] = useState("balanced");
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
