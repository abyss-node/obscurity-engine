import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDiscovery } from "./useDiscovery";

// F3: the backend's 404 on /api/discovery means "no such Last.fm user" (a
// permanent failure) — it must be surfaced distinctly from a genuine
// rate-limit/transient 500, which used to get conflated because a
// nonexistent-username error string coincidentally matched the busy-heuristic
// regex. These tests lock in the three-way mapping in the `!response.ok`
// branch: 404 → USER_NOT_FOUND, rate-limit-worded 500 → busy/SONAR_FAILURE,
// generic 500 → generic SONAR_FAILURE (unchanged from before the fix).

const noop = () => {};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useDiscovery — error classification", () => {
  it("maps a 404 (nonexistent user) to a USER_NOT_FOUND error, not the busy heuristic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          error: 'Last.fm user "nosuchuser123" not found. Check the spelling.',
          code: 404,
        }),
      })
    );

    const { result } = renderHook(() =>
      useDiscovery("nosuchuser123", "7day", "balanced", "artists", "", noop)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/^\[ERR\] USER_NOT_FOUND —/);
    expect(result.current.error).toContain("not found");
    expect(result.current.error?.toLowerCase()).not.toContain("rate");
  });

  it("falls back to a clear not-found message when the backend gives no useful detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      })
    );

    const { result } = renderHook(() =>
      useDiscovery("nosuchuser456", "7day", "balanced", "artists", "", noop)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/^\[ERR\] USER_NOT_FOUND —/);
    expect(result.current.error).toContain("doesn't exist");
  });

  it("maps a rate-limit-worded 500 to the existing busy/retry copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Discovery failed: Last.fm rate limit exceeded", code: 500 }),
      })
    );

    const { result } = renderHook(() =>
      useDiscovery("realuser", "7day", "balanced", "artists", "", noop)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(
      "[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry."
    );
  });

  it("maps a generic 500 to the existing generic SONAR_FAILURE copy (unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Discovery failed: something exploded", code: 500 }),
      })
    );

    const { result } = renderHook(() =>
      useDiscovery("realuser2", "7day", "balanced", "artists", "", noop)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(
      "[ERR] SONAR_FAILURE — The discovery service hit an error; retry in a moment. (Discovery failed: something exploded)"
    );
  });
});

// Tracks-mode fast-follow (mirrors the F3 artists fix on the backend —
// backend/src/lastfm.rs fetch_user_top_tracks + handlers.rs
// track_discovery_handler now surface the same 404/USER_NOT_FOUND for a
// nonexistent user). The `!response.ok` error-classification block above is
// written mode-agnostically — it branches on `response.status`, never on
// `mode` — so it already maps a tracks-endpoint 404 identically. Verified by
// code inspection: not artists-only, so no extension was needed there.
//
// Separately: `mode === "tracks"` currently short-circuits the whole fetch
// effect (still gated behind the "Coming soon" alpha overlay, per the
// comment a few lines above this hook's effect) — so today the tracks
// endpoint is never actually called from this hook regardless of the
// mapping being correct. This test locks in that gate so a future change
// doesn't silently start firing tracks requests (and burning Last.fm rate
// limit) without it being a deliberate decision.
describe("useDiscovery — tracks mode alpha gate", () => {
  it("never fetches in tracks mode (still gated behind the coming-soon overlay)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useDiscovery("realuser3", "7day", "balanced", "tracks", "", noop)
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });
});
