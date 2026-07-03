import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSaved } from "./useSaved";

const postEventMock = vi.fn();
vi.mock("./events", () => ({
  postEvent: (...args: unknown[]) => postEventMock(...args),
}));

const artist = { name: "Artist A", rec_id: "rec-a" };

beforeEach(() => {
  postEventMock.mockReset();
});

describe("useSaved optimistic toggle", () => {
  it("save() marks saved immediately and fires a save event with Bearer semantics delegated to postEvent", async () => {
    postEventMock.mockResolvedValue(true);
    const { result } = renderHook(() => useSaved("run-1"));

    let p: Promise<void>;
    act(() => { p = result.current.save(artist); });
    // optimistic — true before the network resolves
    expect(result.current.isSaved("Artist A")).toBe(true);
    await act(async () => { await p; });

    expect(postEventMock).toHaveBeenCalledWith({ rec_id: "rec-a", run_id: "run-1", type: "save" });
    expect(result.current.isSaved("Artist A")).toBe(true);
  });

  it("rolls back the optimistic save when the event post fails", async () => {
    postEventMock.mockResolvedValue(false);
    const { result } = renderHook(() => useSaved());

    await act(async () => { await result.current.save(artist); });

    expect(result.current.isSaved("Artist A")).toBe(false);
  });

  it("calls onCountChange(+1) only after a confirmed save", async () => {
    postEventMock.mockResolvedValue(true);
    const onCountChange = vi.fn();
    const { result } = renderHook(() => useSaved(null, onCountChange));

    await act(async () => { await result.current.save(artist); });

    expect(onCountChange).toHaveBeenCalledWith(1);
  });

  it("does not call onCountChange when the save fails", async () => {
    postEventMock.mockResolvedValue(false);
    const onCountChange = vi.fn();
    const { result } = renderHook(() => useSaved(null, onCountChange));

    await act(async () => { await result.current.save(artist); });

    expect(onCountChange).not.toHaveBeenCalled();
  });

  it("unsave() optimistically clears saved state and rolls back on failure", async () => {
    postEventMock.mockResolvedValueOnce(true); // initial save succeeds
    const { result } = renderHook(() => useSaved());
    await act(async () => { await result.current.save(artist); });
    expect(result.current.isSaved("Artist A")).toBe(true);

    postEventMock.mockResolvedValueOnce(false); // unsave fails
    await act(async () => { await result.current.unsave(artist); });
    expect(result.current.isSaved("Artist A")).toBe(true); // rolled back
  });

  it("save() no-ops when the item has no rec_id", async () => {
    const { result } = renderHook(() => useSaved());
    await act(async () => { await result.current.save({ name: "No Rec", rec_id: null }); });
    expect(postEventMock).not.toHaveBeenCalled();
    expect(result.current.isSaved("No Rec")).toBe(false);
  });
});
