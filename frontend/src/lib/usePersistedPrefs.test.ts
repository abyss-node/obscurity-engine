import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { usePersistedPrefs } from "./usePersistedPrefs";
import { useUrlModes } from "./useUrlModes";

// Reproduces Home()'s exact hook-call-order wiring from app/page.tsx:
// usePersistedPrefs is called first (so its setters exist), then
// useUrlModes is fed those setters. isSharedView is owned locally, same as
// Home owns it. setUsername/setInputLocal/setMode/setTracks are stubbed —
// this suite only cares about period/appetite/localStorage.
function useHarness() {
  const [isSharedView, setIsSharedView] = useState(false);
  const prefs = usePersistedPrefs(isSharedView);
  useUrlModes({
    setUsername: vi.fn(),
    setInputLocal: vi.fn(),
    setMode: vi.fn(),
    setTracks: vi.fn(),
    setIsSharedView,
    setPeriod: prefs.setPeriod,
    setAppetite: prefs.setAppetite,
    setApiKey: prefs.setApiKey,
    setApiKeyInput: prefs.setApiKeyInput,
  });
  return { ...prefs, isSharedView };
}

let originalLocation: Location;

function setSearch(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, search },
  });
}

beforeEach(() => {
  originalLocation = window.location;
  localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  localStorage.clear();
});

describe("usePersistedPrefs + useUrlModes restore wiring", () => {
  it("restores saved period/appetite on normal mount and does not clobber localStorage", async () => {
    // "high" (not "balanced") so a clobber-to-default is distinguishable
    // from a correct restore.
    localStorage.setItem("obscurity_period", "3month");
    localStorage.setItem("obscurity_appetite", "high");
    setSearch(""); // no ?u=, no ?code&state — the plain/normal mount path

    const { result } = renderHook(() => useHarness());

    await waitFor(() => {
      expect(result.current.period).toBe("3month");
      expect(result.current.appetite).toBe("high");
    });

    // Anti-clobber assertion: the previously-saved value must still be in
    // localStorage after mount settles, not overwritten by the write-back
    // effect's transient pre-restore default. This is the assertion that
    // fails on the pre-fix code (localStorage ends up at "blend"/"balanced").
    expect(localStorage.getItem("obscurity_period")).toBe("3month");
    expect(localStorage.getItem("obscurity_appetite")).toBe("high");
  });

  it("does not persist the shared view's own period/appetite into localStorage", async () => {
    localStorage.setItem("obscurity_period", "3month");
    setSearch("?u=someuser&p=6month"); // shared-view path

    const { result } = renderHook(() => useHarness());

    // The shared URL's own period value IS applied to in-session state.
    await waitFor(() => {
      expect(result.current.period).toBe("6month");
      expect(result.current.isSharedView).toBe(true);
    });

    // Per the traced main behavior (see refactor handoff doc): the
    // write-back effect's first pass always fires with the pre-restore
    // default ("blend") before isSharedView flips true in the same commit;
    // once isSharedView flips, the write-back guard blocks further writes.
    // So the FINAL localStorage state should be the clobbered default, not
    // "6month" and not the pre-existing "3month" — this is a known, accepted
    // main bug (byte-parity requirement), not something this fix corrects.
    expect(localStorage.getItem("obscurity_period")).toBe("blend");
  });
});
