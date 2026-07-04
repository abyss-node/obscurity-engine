"use client";

import { useRef, useState } from "react";
import type { Artist, DiscoveryMode } from "./types";

export type ShareState = "idle" | "rendering" | "saved" | "copied" | "saved-copied";

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

  // POST the current results to /api/share and return the persisted /r/{id}
  // URL, or `null` when the store is unreachable/misconfigured or rejects the
  // payload. Never throws — every caller treats `null` as "no persistent link
  // this time," never as an error to surface.
  const postShare = async (): Promise<string | null> => {
    if (!username || mode !== "artists" || artists.length === 0) return null;
    try {
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
      if (!res.ok) return null;
      const { id } = (await res.json()) as { id?: string };
      if (typeof id !== "string" || !id) return null;
      return `${window.location.origin}/r/${id}`;
    } catch {
      return null; // network / store failure
    }
  };

  // Best-effort clipboard write. `navigator.clipboard` can be undefined in
  // non-secure or permission-denied contexts — treat that identically to a
  // thrown write (silent `false`, never an error state).
  const writeClipboard = async (text: string): Promise<boolean> => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) return false;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  // Copy a shareable link (the fallback path when there's no artist result to
  // render as a PNG — tracks mode / empty). Preferred: persist the actual
  // results via POST /api/share and hand back a stable /r/{id} URL that opens
  // the sender's real results in any browser without recomputing. Fallback
  // (store down, or nothing worth persisting): today's ?u=&p=&a=&m=
  // recompute-on-open URL.
  const copyShareUrl = async () => {
    if (!username) return;
    const origin = window.location.origin;
    const queryUrl = `${origin}${window.location.pathname}?u=${encodeURIComponent(username)}&p=${period}&a=${appetite}&m=${mode}`;
    const persisted = await postShare();
    await writeClipboard(persisted ?? queryUrl);
    setShareState("copied");
    setTimeout(() => setShareState("idle"), 2000);
  };

  // Export the 660×860 result card as a PNG (§8) AND, best-effort in
  // parallel, persist the results via POST /api/share and copy the resulting
  // /r/ link (F4: PNG download + copied link together — owner decision).
  // The link creation/clipboard write is kicked off before the download and
  // only awaited *after* the download has already fired, so a slow or failed
  // network call never delays or blocks the PNG. Falls back to copyShareUrl
  // when there's no artist result to render (tracks mode / empty); any
  // failure in the link path (network, non-2xx, KV absent, clipboard denied)
  // degrades silently to plain PNG-only "saved" feedback — a share click
  // never surfaces an error state.
  const handleShare = async () => {
    if (!username) return;
    const canExport =
      mode === "artists" && artists.length > 0 && depthScore > 0 && shareCardRef.current;
    if (!canExport) {
      await copyShareUrl();
      return;
    }
    const linkPromise = postShare().then((url) => (url ? writeClipboard(url) : false));
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
      const linkCopied = await linkPromise;
      setShareState(linkCopied ? "saved-copied" : "saved");
      setTimeout(() => setShareState("idle"), 2000);
    } catch (e) {
      console.error("Share card export failed:", e);
      setShareState("idle");
      await copyShareUrl(); // never leave the button dead — copy the URL instead
    }
  };

  return { shareCardRef, shareState, handleShare };
}
