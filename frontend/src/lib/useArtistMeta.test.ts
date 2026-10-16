import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { POLL_DELAYS_MS, resetArtistMetaCache, useArtistMeta } from "./useArtistMeta";

const ok = (meta: Record<string, unknown>, pending: string[]) => ({
  ok: true, status: 200, json: async () => ({ meta, pending }),
});
const SE = { country_iso2: "SE", area_name: "Sweden", begin_year: 2014, artist_type: "Group" };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  resetArtistMetaCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const namesOf = (call: number) => new URL(fetchMock.mock.calls[call][0]).searchParams.getAll("name");

describe("useArtistMeta", () => {
  it("requests with repeated encoded name params and settles a result", async () => {
    fetchMock.mockResolvedValue(ok({ "A, B & C": SE }, []));
    const { result } = renderHook(() => useArtistMeta(["A, B & C"]));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(namesOf(0)).toEqual(["A, B & C"]);
    expect(result.current("A, B & C")).toEqual(SE);
  });

  it("polls pending names with backoff and stops when settled", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ A: null }, ["A"]))
      .mockResolvedValueOnce(ok({ A: null }, ["A"]))
      .mockResolvedValueOnce(ok({ A: SE }, []));
    const { result } = renderHook(() => useArtistMeta(["A"]));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(POLL_DELAYS_MS[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(POLL_DELAYS_MS[1] - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current("A")).toEqual(SE);
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-polls only the still-pending names", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ A: SE, B: null }, ["B"]))
      .mockResolvedValueOnce(ok({ B: null }, []));
    const { result } = renderHook(() => useArtistMeta(["A", "B"]));
    await flush(POLL_DELAYS_MS[0]);
    expect(namesOf(1)).toEqual(["B"]);
    expect(result.current("A")).toEqual(SE);
    expect(result.current("B")).toBeNull();
  });

  it("a settled miss (null, not pending) stops polling", async () => {
    fetchMock.mockResolvedValue(ok({ A: null }, []));
    renderHook(() => useArtistMeta(["A"]));
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling a pending name past the old 5-request cap, and fills when it settles at ~60s", async () => {
    let t0 = -1;
    fetchMock.mockImplementation(async () => {
      if (t0 < 0) t0 = Date.now();
      return Date.now() - t0 >= 60_000 ? ok({ A: SE }, []) : ok({ A: null }, ["A"]);
    });
    const { result } = renderHook(() => useArtistMeta(["A"]));
    await flush(59_000);
    expect(result.current("A")).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
    await flush(10_000);
    expect(result.current("A")).toEqual(SE);
  });

  it("backoff is capped at 8s", async () => {
    fetchMock.mockResolvedValue(ok({ A: null }, ["A"]));
    renderHook(() => useArtistMeta(["A"]));
    await flush(30_000);
    const before = fetchMock.mock.calls.length;
    await flush(16_000);
    expect(fetchMock.mock.calls.length - before).toBe(2);
  });

  it("a name that never settles stops at ~90s and keeps no meta", async () => {
    fetchMock.mockResolvedValue(ok({ A: null }, ["A"]));
    const { result } = renderHook(() => useArtistMeta(["A"]));
    await flush(100_000);
    const calls = fetchMock.mock.calls.length;
    await flush(60_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(result.current("A")).toBeUndefined();
  });

  it("aborts polling on unmount", async () => {
    fetchMock.mockResolvedValue(ok({ A: null }, ["A"]));
    const { unmount } = renderHook(() => useArtistMeta(["A"]));
    await flush();
    unmount();
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restarts for a new name set and does not refetch cached names", async () => {
    fetchMock.mockResolvedValue(ok({ A: SE }, []));
    const { rerender } = renderHook(({ n }) => useArtistMeta(n), { initialProps: { n: ["A"] } });
    await flush();
    fetchMock.mockResolvedValue(ok({ B: SE }, []));
    rerender({ n: ["A", "B"] });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(namesOf(1)).toEqual(["B"]);
    rerender({ n: ["B", "A"] });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("404 is silent no-meta and disables further requests this session", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const { result, rerender } = renderHook(({ n }) => useArtistMeta(n), { initialProps: { n: ["A"] } });
    await flush();
    expect(result.current("A")).toBeUndefined();
    rerender({ n: ["A", "B"] });
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a network error is silent and stops this batch", async () => {
    fetchMock.mockRejectedValue(new TypeError("down"));
    const { result } = renderHook(() => useArtistMeta(["A"]));
    await flush(60_000);
    expect(result.current("A")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no request for an empty list", async () => {
    renderHook(() => useArtistMeta([]));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("two consumers asking for the same names share one request; one unmounting does not starve the other", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ A: null }, ["A"]))
      .mockResolvedValueOnce(ok({ A: SE }, []));
    const first = renderHook(() => useArtistMeta(["A"]));
    const second = renderHook(() => useArtistMeta(["A"]));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();
    await flush(POLL_DELAYS_MS[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.result.current("A")).toEqual(SE);
  });

  it("keys results by the requested string exactly", async () => {
    fetchMock.mockResolvedValue(ok({ "Sigur Rós": SE }, []));
    const { result } = renderHook(() => useArtistMeta(["Sigur Rós"]));
    await flush();
    expect(result.current("Sigur Rós")).toEqual(SE);
    expect(result.current("sigur ros")).toBeUndefined();
  });
});

// A backend stub whose fetch HONOURS AbortSignal like the real one: a request in
// flight when its signal aborts rejects with AbortError instead of answering.
// Each name is pending until 3s after it was first requested, then resolves.
describe("useArtistMeta — abort-honouring backend, ownership hand-over", () => {
  let firstSeen: Map<string, number>;
  beforeEach(() => {
    firstSeen = new Map();
    fetchMock.mockImplementation((url: string, init?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const names = new URL(url).searchParams.getAll("name");
        const signal = init?.signal;
        const abortErr = () => new DOMException("aborted", "AbortError");
        if (signal?.aborted) return reject(abortErr());
        const t = setTimeout(() => {
          const now = Date.now();
          const meta: Record<string, unknown> = {};
          const pending: string[] = [];
          for (const n of names) {
            if (!firstSeen.has(n)) firstSeen.set(n, now);
            if (now - firstSeen.get(n)! >= 3000) meta[n] = { ...SE, area_name: n };
            else { meta[n] = null; pending.push(n); }
          }
          resolve(ok(meta, pending));
        }, 500);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortErr()); }, { once: true });
      })
    );
  });

  const all = (get: (n: string) => unknown, names: string[]) => names.every((n) => !!get(n));

  it("StrictMode double-mount still fills every name", async () => {
    const names = ["A", "B", "C"];
    const { result } = renderHook(() => useArtistMeta(names), { wrapper: StrictMode });
    await flush(60_000);
    expect(all(result.current, names)).toBe(true);
  });

  it("reorder mid-poll (sort change) still fills every name", async () => {
    const { result, rerender } = renderHook(({ n }) => useArtistMeta(n), { initialProps: { n: ["A", "B", "C"] } });
    await flush(1000);
    rerender({ n: ["C", "A", "B"] });
    await flush(60_000);
    expect(all(result.current, ["A", "B", "C"])).toBe(true);
  });

  it("grow mid-poll (view more) fills old and new names", async () => {
    const { result, rerender } = renderHook(({ n }) => useArtistMeta(n), { initialProps: { n: ["A", "B"] } });
    await flush(1000);
    rerender({ n: ["A", "B", "C", "D"] });
    await flush(60_000);
    expect(all(result.current, ["A", "B", "C", "D"])).toBe(true);
  });

  it("shrink mid-poll still fills the remaining names", async () => {
    const { result, rerender } = renderHook(({ n }) => useArtistMeta(n), { initialProps: { n: ["A", "B", "C"] } });
    await flush(1000);
    rerender({ n: ["B"] });
    await flush(60_000);
    expect(all(result.current, ["B"])).toBe(true);
  });

  it("unmounting one holder mid-poll does not starve the other", async () => {
    const first = renderHook(() => useArtistMeta(["A", "B"]));
    const second = renderHook(() => useArtistMeta(["A", "B", "C"]));
    await flush(1000);
    first.unmount();
    await flush(60_000);
    expect(all(second.result.current, ["A", "B", "C"])).toBe(true);
  });
});
