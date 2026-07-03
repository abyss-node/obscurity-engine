import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDismissal, UNDO_WINDOW_MS } from "./useDismissal";

const postEventMock = vi.fn().mockResolvedValue(true);
vi.mock("./events", () => ({
  postEvent: (...args: unknown[]) => postEventMock(...args),
}));

const items = [
  { name: "Artist A", rec_id: "rec-a" },
  { name: "Artist B", rec_id: "rec-b" },
  { name: "Artist C", rec_id: "rec-c" },
  { name: "Artist D", rec_id: "rec-d" },
];

beforeEach(() => {
  vi.useFakeTimers();
  postEventMock.mockClear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("useDismissal state machine", () => {
  it("starts with everything visible and nothing pending", () => {
    const { result } = renderHook(() => useDismissal(items));
    expect(result.current.visible).toHaveLength(4);
    expect(result.current.pending.size).toBe(0);
  });

  it("dismiss() marks the item pending but keeps it in `visible` (renders the undo row in place)", () => {
    const { result } = renderHook(() => useDismissal(items, { runId: "run-1" }));

    act(() => result.current.dismiss(items[0]));

    expect(result.current.pending.has("Artist A")).toBe(true);
    expect(result.current.visible.map((i) => i.name)).toEqual(["Artist A", "Artist B", "Artist C", "Artist D"]);
    expect(postEventMock).toHaveBeenCalledWith({ rec_id: "rec-a", run_id: "run-1", type: "dismiss" });
  });

  it("confirms the dismissal after the 5s undo window elapses, dropping it from `visible` (backfill)", () => {
    const { result } = renderHook(() => useDismissal(items));

    act(() => result.current.dismiss(items[0]));
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS - 1); });
    // still within the window
    expect(result.current.visible.map((i) => i.name)).toContain("Artist A");
    expect(result.current.pending.has("Artist A")).toBe(true);

    act(() => { vi.advanceTimersByTime(2); });
    // window elapsed — confirmed, dropped, no longer pending
    expect(result.current.pending.has("Artist A")).toBe(false);
    expect(result.current.visible.map((i) => i.name)).toEqual(["Artist B", "Artist C", "Artist D"]);

    // Simulates the consumer's `shown` slice: a 2-item window that used to
    // show [A, B] now backfills C into view purely because `visible` shrank —
    // no separate "backfill" call is needed.
    expect(result.current.visible.slice(0, 2).map((i) => i.name)).toEqual(["Artist B", "Artist C"]);
  });

  it("undo() before the window elapses restores the item and cancels the timer", () => {
    const { result } = renderHook(() => useDismissal(items, { runId: "run-1" }));

    act(() => result.current.dismiss(items[0]));
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => result.current.undo(items[0]));

    expect(result.current.pending.has("Artist A")).toBe(false);
    expect(result.current.visible.map((i) => i.name)).toEqual(["Artist A", "Artist B", "Artist C", "Artist D"]);
    expect(postEventMock).toHaveBeenCalledWith({ rec_id: "rec-a", run_id: "run-1", type: "undo_dismiss" });

    // Advancing well past the original window must NOT confirm-remove it —
    // the timer was cancelled by undo().
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 1000); });
    expect(result.current.visible.map((i) => i.name)).toContain("Artist A");
  });

  it("double-dismissing the same item resets its timer instead of double-scheduling", () => {
    const { result } = renderHook(() => useDismissal(items));

    act(() => result.current.dismiss(items[0]));
    act(() => { vi.advanceTimersByTime(4000); });
    act(() => result.current.dismiss(items[0])); // re-dismiss resets the clock
    act(() => { vi.advanceTimersByTime(4000); });
    // 8s of real time elapsed, but only 4s since the second dismiss — still pending
    expect(result.current.pending.has("Artist A")).toBe(true);

    act(() => { vi.advanceTimersByTime(1001); });
    expect(result.current.pending.has("Artist A")).toBe(false);
  });

  it("dismiss() no-ops when the item has no rec_id (capability-gated upstream too)", () => {
    const { result } = renderHook(() => useDismissal([{ name: "No Rec", rec_id: null }]));
    act(() => result.current.dismiss({ name: "No Rec", rec_id: null }));
    expect(result.current.pending.size).toBe(0);
    expect(postEventMock).not.toHaveBeenCalled();
  });

  it("multiple concurrent dismissals each track their own undo window independently", () => {
    const { result } = renderHook(() => useDismissal(items));

    act(() => result.current.dismiss(items[0])); // t=0
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => result.current.dismiss(items[1])); // t=2000

    act(() => { vi.advanceTimersByTime(3001); }); // t=5001 -> A confirmed, B still pending (2000+5000=7000)
    expect(result.current.pending.has("Artist A")).toBe(false);
    expect(result.current.pending.has("Artist B")).toBe(true);
    expect(result.current.visible.map((i) => i.name)).toEqual(["Artist B", "Artist C", "Artist D"]);

    act(() => { vi.advanceTimersByTime(2000); }); // t=7001 -> B confirmed too
    expect(result.current.pending.has("Artist B")).toBe(false);
    expect(result.current.visible.map((i) => i.name)).toEqual(["Artist C", "Artist D"]);
  });
});
