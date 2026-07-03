/**
 * Last.fm web-auth session storage + helpers, per the Phase 1 pinned API
 * contract (docs/phase1-tasks-2026-07-03.md):
 *
 *   1. FE sends the user to last.fm/api/auth?api_key=&cb=<FRONTEND_URL>/auth/lastfm
 *   2. Last.fm redirects back with ?token=T
 *   3. FE POSTs {token} to /api/auth/session
 *   4. Backend returns {session_token, username, user_id}
 *   5. FE stores the token and sends `Authorization: Bearer <token>` on
 *      writes and personal reads. Logout = DELETE /api/auth/session.
 *
 * Graceful fallback: without NEXT_PUBLIC_LASTFM_API_KEY the login entry point
 * hides entirely (isLoginConfigured() === false) — no dead button, no broken
 * flow. All storage access is try/caught so a locked-down localStorage (private
 * browsing, quota) degrades to "logged out" rather than throwing into the UI.
 */

const SESSION_KEY = "obscurity_session";

export type Session = {
  session_token: string;
  username: string;
  user_id: string;
};

function apiUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
}

function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.session_token === "string" && o.session_token.length > 0 &&
    typeof o.username === "string" && o.username.length > 0 &&
    typeof o.user_id === "string" && o.user_id.length > 0
  );
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable — session stays in-memory for this render only */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* noop */
  }
}

/** `Authorization: Bearer <token>` header when a session exists, else `{}`. */
export function authHeader(): Record<string, string> {
  const session = getSession();
  return session ? { Authorization: `Bearer ${session.session_token}` } : {};
}

/** True only when NEXT_PUBLIC_LASTFM_API_KEY is set at build time. */
export function isLoginConfigured(): boolean {
  return (process.env.NEXT_PUBLIC_LASTFM_API_KEY ?? "").length > 0;
}

/** Builds the last.fm web-auth URL, or `null` when login isn't configured. */
export function buildLoginUrl(): string | null {
  const apiKey = process.env.NEXT_PUBLIC_LASTFM_API_KEY ?? "";
  if (!apiKey || typeof window === "undefined") return null;
  const cb = `${window.location.origin}/auth/lastfm`;
  const params = new URLSearchParams({ api_key: apiKey, cb });
  return `https://www.last.fm/api/auth?${params.toString()}`;
}

/**
 * Exchanges a last.fm auth token for a session via POST /api/auth/session,
 * storing it on success. Returns `null` on any failure (network, non-2xx,
 * malformed body, or the backend's 503 when LASTFM_API_SECRET is unset) —
 * callers show a generic "couldn't sign you in" state, never throw.
 */
export async function exchangeToken(token: string): Promise<Session | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isSession(data)) return null;
    setSession(data);
    return data;
  } catch {
    return null;
  }
}

/** Clears the local session and best-effort informs the backend. */
export async function logout(): Promise<void> {
  const session = getSession();
  clearSession();
  if (!session) return;
  try {
    await fetch(`${apiUrl()}/api/auth/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.session_token}` },
    });
  } catch {
    /* best-effort — the local session is already cleared */
  }
}
