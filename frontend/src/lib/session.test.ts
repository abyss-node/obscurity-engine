import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getSession,
  setSession,
  clearSession,
  authHeader,
  isLoginConfigured,
  buildLoginUrl,
  exchangeToken,
  logout,
} from "./session";

const SESSION_KEY = "obscurity_session";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("session storage roundtrip", () => {
  it("returns null when nothing is stored", () => {
    expect(getSession()).toBeNull();
  });

  it("stores and retrieves a valid session", () => {
    const session = { session_token: "tok-abc", username: "alice", user_id: "u-1" };
    setSession(session);
    expect(getSession()).toEqual(session);
  });

  it("clearSession removes the stored session", () => {
    setSession({ session_token: "t", username: "bob", user_id: "u-2" });
    clearSession();
    expect(getSession()).toBeNull();
  });

  it("rejects malformed stored JSON as logged-out", () => {
    localStorage.setItem(SESSION_KEY, "{not json");
    expect(getSession()).toBeNull();
  });

  it("rejects a stored object missing required fields", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ username: "alice" }));
    expect(getSession()).toBeNull();
  });

  it("degrades to logged-out when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(getSession()).toBeNull();
  });
});

describe("authHeader", () => {
  it("is empty when logged out", () => {
    expect(authHeader()).toEqual({});
  });

  it("carries a Bearer token when a session exists", () => {
    setSession({ session_token: "tok-xyz", username: "alice", user_id: "u-1" });
    expect(authHeader()).toEqual({ Authorization: "Bearer tok-xyz" });
  });
});

describe("isLoginConfigured / buildLoginUrl", () => {
  it("hides login when NEXT_PUBLIC_LASTFM_API_KEY is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_LASTFM_API_KEY", "");
    expect(isLoginConfigured()).toBe(false);
    expect(buildLoginUrl()).toBeNull();
  });

  it("builds a last.fm auth URL pointing back to /auth/lastfm when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_LASTFM_API_KEY", "test-key-123");
    expect(isLoginConfigured()).toBe(true);
    const url = buildLoginUrl();
    expect(url).toContain("https://www.last.fm/api/auth?");
    expect(url).toContain("api_key=test-key-123");
    expect(url).toContain(encodeURIComponent(`${window.location.origin}/auth/lastfm`));
  });
});

describe("exchangeToken", () => {
  it("stores and returns the session on a successful exchange", async () => {
    const body = { session_token: "tok-1", username: "alice", user_id: "u-1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    }));
    const session = await exchangeToken("lastfm-token");
    expect(session).toEqual(body);
    expect(getSession()).toEqual(body);
  });

  it("returns null and does not store a session on a non-2xx response (e.g. 503 secret unset)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "disabled", code: 503 }) }));
    const session = await exchangeToken("lastfm-token");
    expect(session).toBeNull();
    expect(getSession()).toBeNull();
  });

  it("returns null on a network failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(exchangeToken("lastfm-token")).resolves.toBeNull();
  });

  it("returns null on a malformed success body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) }));
    expect(await exchangeToken("t")).toBeNull();
  });
});

describe("logout", () => {
  it("clears the local session and best-effort DELETEs the backend session", async () => {
    setSession({ session_token: "tok-1", username: "alice", user_id: "u-1" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    expect(getSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/session"),
      expect.objectContaining({ method: "DELETE", headers: { Authorization: "Bearer tok-1" } })
    );
  });

  it("is a no-op network-wise when there was no session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await logout();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws even if the DELETE request fails", async () => {
    setSession({ session_token: "tok-1", username: "alice", user_id: "u-1" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(logout()).resolves.toBeUndefined();
    expect(getSession()).toBeNull();
  });
});
