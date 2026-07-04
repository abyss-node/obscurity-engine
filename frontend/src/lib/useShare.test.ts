import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useShare } from "./useShare";
import type { Artist } from "./types";

// F4 (top-bar share = PNG download AND copied /r/ link, owner decision):
// before this fix, the top-bar share button's canExport branch only ever
// exported the PNG — the persistent-link POST /api/share + clipboard copy
// wiring (`copyShareUrl`) existed but was only reachable from the no-artists
// fallback path. These tests lock in the combined behavior: the PNG download
// must never be blocked or skipped by the network call, and a failed/absent
// link creation or clipboard write must degrade silently to today's
// PNG-only "saved" feedback — never an error state.

const toPngMock = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
vi.mock("html-to-image", () => ({
  toPng: (...args: unknown[]) => toPngMock(...args),
}));

function makeArtist(name = "Duster"): Artist {
  return {
    name,
    stickiness_score: 40,
    conviction_score: 120,
    composite_score: 60,
    total_listeners: 8000,
    top_tags: ["slowcore"],
    source_seeds: [{ name: "Bedhead", percentile: 12 }],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toPngMock.mockClear();
  toPngMock.mockResolvedValue("data:image/png;base64,AAAA");
  // jsdom has no document.fonts — the hook awaits document.fonts.ready before
  // snapshotting, so stub it exactly like a resolved FontFaceSet would behave.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // vi.restoreAllMocks() does not undo vi.stubGlobal — without this, a
  // stubbed `navigator`/`fetch` from one test silently leaks into the next.
  vi.unstubAllGlobals();
  // @ts-expect-error -- test-only cleanup of the stub above
  delete document.fonts;
});

/** Render the hook with a canExport-eligible artists result and a fake
 * off-screen card node attached (mirrors the real ShareCard ref wiring). */
function renderExportableShare(artists: Artist[] = [makeArtist()]) {
  const hook = renderHook(() =>
    useShare("alice", "artists", artists, 42, "blend", "balanced")
  );
  hook.result.current.shareCardRef.current = document.createElement("div");
  return hook;
}

describe("useShare — top-bar share (PNG + persistent link together)", () => {
  it("posts the artists payload to /api/share, copies the /r/ url, and still downloads the PNG", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "abc1234567" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderExportableShare();

    await act(async () => {
      await result.current.handleShare();
    });

    // Payload shape matches the existing copyShareUrl POST — mode "artists".
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/share",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      username: "alice",
      period: "blend",
      mode: "artists",
      appetite: "balanced",
    });
    expect(body.recommendations).toHaveLength(1);

    // The persisted /r/ url was copied.
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/r/abc1234567"));

    // The PNG download still fired.
    expect(toPngMock).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    await waitFor(() => expect(result.current.shareState).toBe("saved-copied"));
  });

  it("degrades to PNG-only when share creation fails (network/4xx/5xx/KV absent) — never an error state", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderExportableShare();

    await act(async () => {
      await result.current.handleShare();
    });

    // No link was ever copied (the fetch failure means postShare resolved null).
    expect(writeText).not.toHaveBeenCalled();
    // But the PNG still downloaded, and no exception propagated.
    expect(toPngMock).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    await waitFor(() => expect(result.current.shareState).toBe("saved"));
  });

  it("degrades to PNG-only when the share POST returns a non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderExportableShare();

    await act(async () => {
      await result.current.handleShare();
    });

    expect(writeText).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.shareState).toBe("saved"));
  });

  it("never throws when navigator.clipboard is undefined (non-secure context / denied permission)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "xyz9988776" }) });
    vi.stubGlobal("fetch", fetchMock);
    // jsdom's real `navigator` has no Clipboard API at all by default (unlike
    // a real secure-context browser) — exactly the condition this test wants
    // to model, so no stubbing is needed/wanted here.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderExportableShare();

    // A plain await — if handleShare threw, this await itself would reject
    // and fail the test with that exception surfaced.
    await act(async () => {
      await result.current.handleShare();
    });

    expect(toPngMock).toHaveBeenCalled();
    await waitFor(() => expect(result.current.shareState).toBe("saved"));
  });

  it("on PNG export failure, reuses the in-flight link POST instead of double-posting (link succeeded)", async () => {
    toPngMock.mockRejectedValueOnce(new Error("canvas tainted"));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "png0000001" }) });
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { result } = renderExportableShare();

    await act(async () => {
      await result.current.handleShare();
    });

    // Exactly ONE POST /api/share — no duplicate KV record from the catch path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The already-in-flight link POST succeeded and was copied — no second
    // (query-param) clipboard write should follow it.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/r/png0000001"));
    await waitFor(() => expect(result.current.shareState).toBe("copied"));
  });

  it("on PNG export failure, falls back to the query-param URL without a second POST when the link POST fails", async () => {
    toPngMock.mockRejectedValueOnce(new Error("canvas tainted"));
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { result } = renderExportableShare();

    await act(async () => {
      await result.current.handleShare();
    });

    // Exactly ONE POST attempt (from the original linkPromise) — the failure
    // path must not retry the POST via a second postShare() call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Falls back to the query-param recompute-on-open URL, copied exactly once.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("m=artists"));
    await waitFor(() => expect(result.current.shareState).toBe("copied"));
  });

  it("does not block the PNG download on a slow network call", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    // The download (anchor .click()) fires before `postShare`'s fetch is
    // awaited in handleShare, so by the time this spy runs, the still-pending
    // fetch proves the PNG wasn't blocked on the network call. Resolve it
    // from here so the rest of handleShare can settle within one `act`.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      expect(fetchMock).toHaveBeenCalled();
      resolveFetch({ ok: true, json: async () => ({ id: "slow000001" }) });
    });

    const { result } = renderExportableShare();

    await act(async () => {
      await result.current.handleShare();
    });

    expect(clickSpy).toHaveBeenCalled();
    await waitFor(() => expect(result.current.shareState).toBe("saved-copied"));
  });
});

describe("useShare — fallback copy-link path (tracks mode / no artist result)", () => {
  it("still copies a link (persistent when possible) and never attempts a PNG export", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "trk0000001" }) });
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { result } = renderHook(() =>
      useShare("alice", "tracks", [], 0, "blend", "balanced")
    );

    await act(async () => {
      await result.current.handleShare();
    });

    expect(toPngMock).not.toHaveBeenCalled();
    // Tracks mode never posts to /api/share (mode !== "artists" short-circuits
    // postShare) — falls straight to the query-param recompute-on-open URL.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("m=tracks"));
    await waitFor(() => expect(result.current.shareState).toBe("copied"));
  });
});
