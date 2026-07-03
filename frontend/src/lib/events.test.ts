import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { postEvent } from "./events";
import { setSession } from "./session";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("postEvent guard clause", () => {
  it("no-ops (resolves false) without any network call when neither id is present", async () => {
    const beacon = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ type: "click_listen" });

    expect(ok).toBe(false);
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("anonymous events (click_listen / share) — keepalive fetch, credentials omitted", () => {
  // F1 (QA 2026-07-03): sendBeacon is spec'd to ALWAYS send credentials
  // ("include" mode, not configurable), and its application/json Blob forces
  // a credentialed CORS preflight that the backend (which never sends
  // Access-Control-Allow-Credentials) rejects — so every beacon silently
  // failed in prod. All events must therefore go through fetch with
  // keepalive (same navigate-away survival) and credentials: "omit".
  it("never uses sendBeacon even when it is available", async () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", type: "click_listen" });

    expect(ok).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POSTs the contract payload shape to /api/events with keepalive and credentials omitted", async () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", run_id: "run-1", type: "click_listen", target: "spotify" });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/events");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      rec_id: "rec-1",
      run_id: "run-1",
      type: "click_listen",
      target: "spotify",
    });
  });

  it("fires a share event without a target field", async () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await postEvent({ rec_id: "rec-1", type: "share" });

    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.type).toBe("share");
    expect(parsed.target).toBeUndefined();
    expect(init.credentials).toBe("omit");
  });

  it("works when navigator is undefined entirely (SSR-adjacent environments)", async () => {
    vi.stubGlobal("navigator", undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", type: "click_listen" });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.keepalive).toBe(true);
  });

  it("never throws — resolves false when fetch rejects", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(postEvent({ rec_id: "rec-1", type: "share" })).resolves.toBe(false);
  });
});

describe("authed events (save / unsave / dismiss / undo_dismiss) — fetch + Bearer", () => {
  it("carries the Bearer header, keepalive, and credentials omitted (never sendBeacon)", async () => {
    setSession({ session_token: "tok-1", username: "alice", user_id: "u-1" });
    const beacon = vi.fn().mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", type: "save" });

    expect(ok).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok-1");
    expect(init.keepalive).toBe(true);
    // F1: Bearer carries auth — cookies must stay opted out even here.
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body)).toEqual({ rec_id: "rec-1", type: "save" });
  });

  it("omits the Authorization header when logged out (backend rejects; client never throws)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", type: "dismiss" });

    expect(ok).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("propagates a non-2xx as a false result, not a throw", async () => {
    setSession({ session_token: "tok-1", username: "alice", user_id: "u-1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(postEvent({ rec_id: "rec-1", type: "unsave" })).resolves.toBe(false);
  });
});
