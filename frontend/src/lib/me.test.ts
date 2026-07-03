import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSaved } from "./me";
import { setSession } from "./session";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("fetchSaved", () => {
  it("sends the Bearer header from the stored session", async () => {
    setSession({ session_token: "tok-1", username: "alice", user_id: "u-1" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ saved: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchSaved();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/me/saved");
    expect(init.headers.Authorization).toBe("Bearer tok-1");
  });

  it("accepts an {saved: [...]} envelope", async () => {
    const list = [{ rec_id: "r1", artist_name: "Duster" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ saved: list }) }));
    await expect(fetchSaved()).resolves.toEqual(list);
  });

  it("accepts a bare array response", async () => {
    const list = [{ rec_id: "r1", artist_name: "Duster" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => list }));
    await expect(fetchSaved()).resolves.toEqual(list);
  });

  it("throws with the {error,code} envelope's message on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid session", code: 401 }),
    }));
    await expect(fetchSaved()).rejects.toThrow("invalid session");
  });

  it("falls back to an HTTP status message when the error body isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    }));
    await expect(fetchSaved()).rejects.toThrow("HTTP 500");
  });
});
