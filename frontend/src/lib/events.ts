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
 * Every event type goes through `fetch(..., { keepalive: true, credentials:
 * "omit" })` — deliberately NOT `navigator.sendBeacon`:
 *
 * - sendBeacon is spec'd to always use credentials mode "include" (it is not
 *   configurable), and a Blob with type application/json is a non-simple
 *   request, so the browser issues a *credentialed* CORS preflight. Our
 *   backend's CORS layer never sends `Access-Control-Allow-Credentials`
 *   (correctly — no cookies exist in this app, and tower-http forbids
 *   credentials alongside its `Any` allow-headers), so every sendBeacon
 *   event was CORS-blocked in prod (QA 2026-07-03 F1).
 * - `keepalive: true` provides the same survive-page-navigation guarantee
 *   sendBeacon was originally chosen for, in all modern browsers, while
 *   letting us pin `credentials: "omit"`.
 *
 * `save` / `unsave` / `dismiss` / `undo_dismiss` additionally carry the
 * Bearer header per the contract, and callers await the boolean result to
 * drive optimistic-UI rollback. Auth is exclusively that header — cookies
 * must stay opted out ("omit", never fetch's "same-origin" default) or the
 * credential-less CORS layer silently blocks the request in prod.
 */
export async function postEvent(payload: EventPayload): Promise<boolean> {
  if (!payload.rec_id && !payload.run_id) return false; // contract: at least one id required

  const url = `${apiUrl()}/api/events`;
  const body = JSON.stringify(payload);
  const needsAuth = AUTH_REQUIRED.has(payload.type);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (needsAuth) Object.assign(headers, authHeader());

    const res = await fetch(url, { method: "POST", headers, body, keepalive: true, credentials: "omit" });
    return res.ok;
  } catch {
    return false;
  }
}
