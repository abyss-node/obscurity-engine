"use client";

import { useEffect, useState } from "react";
import LoadingState from "@/components/LoadingState";
import { exchangeToken } from "@/lib/session";

/**
 * Last.fm web-auth callback (pinned contract step 2-4): last.fm redirects
 * here with `?token=T`; we exchange it for a session via
 * POST /api/auth/session, store it, then return home. Reads
 * window.location.search directly (matching the existing Spotify-callback
 * pattern in app/page.tsx) rather than next/navigation's useSearchParams, so
 * this stays a plain client component with no Suspense-boundary requirement.
 */
export default function LastfmAuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      window.location.replace("/");
      return;
    }

    let cancelled = false;
    (async () => {
      const session = await exchangeToken(token);
      if (cancelled) return;
      if (!session) {
        setError("couldn't sign you in — redirecting");
        setTimeout(() => {
          if (!cancelled) window.location.replace("/");
        }, 1800);
        return;
      }
      window.location.replace("/");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center">
        <p className="font-mono text-[11px] tracking-widest" style={{ color: "var(--discovery)" }}>
          [ERR] AUTH_FAILURE — {error}
        </p>
      </div>
    );
  }

  return <LoadingState />;
}
