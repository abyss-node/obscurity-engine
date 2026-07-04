/**
 * Shared `/api/discovery` (and `/api/discovery/tracks`) non-OK-response error
 * classification, extracted verbatim out of useDiscovery.ts's `!response.ok`
 * branch (see the comment there for the full rationale). Pulled into its own
 * pure function so useCompare.ts's visitor-side fetch (the "compare with a
 * friend" feature) can reuse the exact same [ERR]-prefixed copy instead of
 * re-deriving it — any divergence here would mean the same backend failure
 * reads as a different, un-audited error string depending on which caller hit
 * it.
 *
 * Timeout / network-level failures happen before a `Response` even exists (a
 * thrown `DOMException`/`TypeError` from `fetch` itself) and so can't be
 * expressed as a (status, detail) pair — those two branches stay inline in
 * each caller's `catch` block, unchanged, but must still produce the
 * identical strings defined here as the single source of truth (see
 * `TIMEOUT_ERROR` / `NETWORK_ERROR` below).
 */

// Reused verbatim by every caller's catch block for the two failure modes
// that happen below the HTTP layer (no status code to branch on).
export const TIMEOUT_ERROR =
  "[ERR] SONAR_FAILURE — Request timed out after 90s. The service may be busy; retry.";
export const NETWORK_ERROR =
  "[ERR] SONAR_FAILURE — Couldn't reach the discovery service. It may be starting up or blocked; retry in a moment.";

/**
 * Classify a non-OK `/api/discovery*` response into the app's `[ERR] CODE —
 * message` copy. `detail` is the already-extracted `body.error` string when
 * the response body parsed as JSON and carried an `error` field, or `null`
 * otherwise (bodyless, non-JSON, or JSON without an `error` field) — the
 * caller is responsible for that extraction (it also needs to know whether
 * parsing/the field succeeded, which this function receives via `detail`
 * being non-null vs null; see `hasAppErrorDetail` in the caller).
 *
 * `status` is the HTTP status code; when `detail` is `null`, "HTTP <status>"
 * is used as the generic detail text, exactly as the original inline logic did.
 */
export function classifyDiscoveryError(status: number, detail: string | null): string {
  const hasAppErrorDetail = detail !== null;
  const resolvedDetail = detail ?? `HTTP ${status}`;

  // The backend's only 404 on this endpoint is "no such Last.fm user" — a
  // permanent, non-retryable state. Must be checked before the busy
  // heuristic below: a nonexistent username's error text can otherwise
  // coincidentally match the rate-limit wording and get mislabeled as a
  // transient failure (it isn't — retrying won't help). But a 404 can also
  // come from a framework/proxy layer (misrouted request, wrong API base)
  // whose body isn't the app's error JSON at all — that must NOT be
  // confidently reported as "this username doesn't exist", so
  // USER_NOT_FOUND requires the app's actual error shape (a parseable JSON
  // body carrying an `error` field); an unparseable/bodyless 404 falls
  // through to the generic failure copy below instead.
  if (status === 404 && hasAppErrorDetail) {
    return `[ERR] USER_NOT_FOUND — ${resolvedDetail}`;
  }

  // Upstream rate-limit / busy signatures from the backend → actionable hint
  // instead of a raw "error decoding response body".
  const busy =
    status >= 500 &&
    /rate limit|error decoding|failed to fetch|temporarily|unavailable/i.test(resolvedDetail);
  if (busy) {
    return "[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry.";
  }
  if (status >= 500) {
    return `[ERR] SONAR_FAILURE — The discovery service hit an error; retry in a moment. (${resolvedDetail})`;
  }
  return `[ERR] SONAR_FAILURE — ${resolvedDetail}`;
}
