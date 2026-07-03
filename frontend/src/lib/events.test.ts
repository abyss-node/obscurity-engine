import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { postEvent } from "./events";
import { setSession } from "./session";

// jsdom's Blob polyfill doesn't implement .text()/.arrayBuffer(), and its
// Blob isn't recognized by Node's own Response constructor either — jsdom's
// FileReader is the one thing that reads it reliably in this environment.
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

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

describe("anonymous events (click_listen / share) — sendBeacon path", () => {
  it("sends a Blob with application/json to /api/events via sendBeacon", async () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });

    const ok = await postEvent({ rec_id: "rec-1", run_id: "run-1", type: "click_listen", target: "spotify" });

    expect(ok).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toContain("/api/events");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
    const text = await blobText(blob);
    expect(JSON.parse(text)).toEqual({
      rec_id: "rec-1",
      run_id: "run-1",
      type: "click_listen",
      target: "spotify",
    });
  });

  it("fires a share event without a target field", async () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });

    await postEvent({ rec_id: "rec-1", type: "share" });

    const blob = beacon.mock.calls[0][1] as Blob;
    const parsed = JSON.parse(await blobText(blob));
    expect(parsed.type).toBe("share");
  });

  it("falls back to fetch keepalive when sendBeacon is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", type: "click_listen" });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/events");
    expect(init.keepalive).toBe(true);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("falls back to fetch when sendBeacon queues the request and returns false", async () => {
    const beacon = vi.fn().mockReturnValue(false);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await postEvent({ rec_id: "rec-1", type: "click_listen" });

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
  });

  it("never throws — resolves false when fetch rejects", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(postEvent({ rec_id: "rec-1", type: "share" })).resolves.toBe(false);
  });
});

describe("authed events (save / unsave / dismiss / undo_dismiss) — always fetch + Bearer", () => {
  it("skips sendBeacon entirely (it can't carry the Authorization header)", async () => {
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
