"use client";

import { useRef, useState } from "react";
import type { Artist, DiscoveryMode } from "./types";

export type ShareState = "idle" | "rendering" | "saved" | "copied";

/**
 * PNG export (html-to-image, dynamic import) + copy-link fallback + the
 * persistent share POST / `/r/` URL fallback semantics, moved verbatim out
 * of app/page.tsx. `shareCardRef` is attached by the caller to the off-screen
 * ShareCard node that's the PNG snapshot source.
 */
export function useShare(
  username: string | null,
  mode: DiscoveryMode,
  artists: Artist[],
  depthScore: number,
  period: string,
  appetite: string
) {
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [shareState, setShareState] = useState<ShareState>("idle");

  // Copy a shareable link. Preferred: persist the actual results via
  // POST /api/share and hand back a stable /r/{id} URL that opens the sender's
  // real results in any browser without recomputing. Fallback (store down, or
  // nothing worth persisting): today's ?u=&p=&a=&m= recompute-on-open URL.
  const copyShareUrl = async () => {
    if (!username) return;
    const origin = window.location.origin;
    const queryUrl = `${origin}${window.location.pathname}?u=${encodeURIComponent(username)}&p=${period}&a=${appetite}&m=${mode}`;
    let shareUrl = queryUrl;
    try {
      if (mode === "artists" && artists.length > 0) {
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            period,
            mode,
            appetite,
            recommendations: artists,
            computedAt: Date.now(),
          }),
        });
        if (res.ok) {
          const { id } = (await res.json()) as { id?: string };
          if (typeof id === "string" && id) shareUrl = `${origin}/r/${id}`;
        }
      }
    } catch {
      /* network / store failure — keep the query-param fallback URL */
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      /* clipboard unavailable — nothing further we can do */
    }
    setShareState("copied");
    setTimeout(() => setShareState("idle"), 2000);
  };

  // Export the 660×860 result card as a PNG (§8). Falls back to copying the
  // share URL when there's no artist result to render (tracks mode / empty).
  const handleShare = async () => {
    if (!username) return;
    const canExport =
      mode === "artists" && artists.length > 0 && depthScore > 0 && shareCardRef.current;
    if (!canExport) {
      await copyShareUrl();
      return;
    }
    try {
      setShareState("rendering");
      const { toPng } = await import("html-to-image");
      // Wait for the self-hosted web fonts so Playfair/Plex render in the snapshot.
      await document.fonts.ready;
      const node = shareCardRef.current!;
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#080806",
        width: node.offsetWidth,
        height: node.offsetHeight,
        cacheBust: true,
      });
      const link = document.createElement("a");
      link.download = `obscurity-${username}-${period}.png`;
      link.href = dataUrl;
      link.click();
      setShareState("saved");
      setTimeout(() => setShareState("idle"), 2000);
    } catch (e) {
      console.error("Share card export failed:", e);
      setShareState("idle");
      await copyShareUrl(); // never leave the button dead — copy the URL instead
    }
  };

  return { shareCardRef, shareState, handleShare };
}
