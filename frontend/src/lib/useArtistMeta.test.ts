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

  it("gives up after five requests while still pending", async () => {
    fetchMock.mockResolvedValue(ok({ A: null }, ["A"]));
    const { result } = renderHook(() => useArtistMeta(["A"]));
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(POLL_DELAYS_MS.length + 1);
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
});
