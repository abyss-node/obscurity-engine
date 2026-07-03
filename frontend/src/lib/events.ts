import { authHeader } from "./session";

/** Per the pinned contract's POST /api/events body. */
export type EventType = "click_listen" | "save" | "unsave" | "dismiss" | "undo_dismiss" | "share";

export type EventPayload = {
  rec_id?: string | null;
  run_id?: string | null;
  type: EventType;
  target?: "lastfm" | "spotify" | "bandcamp" | "thisis";
  dedup_key?: string;
};

// save/unsave/dismiss/undo_dismiss require Bearer per the contract; anonymous
// events are allowed only for click_listen/share.
const AUTH_REQUIRED: ReadonlySet<EventType> = new Set<EventType>([
  "save",
  "unsave",
  "dismiss",
  "undo_dismiss",
]);

function apiUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
}

/**
 * Fires a `POST /api/events` beacon. Never throws and never blocks the
 * calling UI: every failure mode (missing ids, network error, non-2xx)
 * resolves to `false` instead of rejecting.
 *
 * - `click_listen` / `share` (anonymous-ok): prefers `navigator.sendBeacon`
 *   (survives page navigation on link clicks) with a `fetch(..., {keepalive})`
 *   fallback when sendBeacon is unavailable or the browser rejects it.
 * - `save` / `unsave` / `dismiss` / `undo_dismiss`: always `fetch` with the
 *   Bearer header (sendBeacon cannot carry custom headers) and the caller
 *   awaits the boolean result to drive optimistic-UI rollback.
 */
export async function postEvent(payload: EventPayload): Promise<boolean> {
  if (!payload.rec_id && !payload.run_id) return false; // contract: at least one id required

  const url = `${apiUrl()}/api/events`;
  const body = JSON.stringify(payload);
  const needsAuth = AUTH_REQUIRED.has(payload.type);

  try {
    if (
      !needsAuth &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return true;
      // sendBeacon returned false (queue full / browser refused) — fall through to fetch.
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (needsAuth) Object.assign(headers, authHeader());

    const res = await fetch(url, { method: "POST", headers, body, keepalive: true });
    return res.ok;
  } catch {
    return false;
  }
}
