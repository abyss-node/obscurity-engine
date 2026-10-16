import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
// Adds the toBeInTheDocument()/etc jest-dom matchers used by P1-B's RTL
// component tests (ArtistCard, SavedView, the /auth/lastfm callback).
import "@testing-library/jest-dom/vitest";

// Unmount anything rendered via @testing-library/react between tests so the
// jsdom document stays clean for the next case.
afterEach(() => {
  cleanup();
});

// The suite makes zero real network calls: any test that does not install its
// own fetch stub gets one that rejects (the app treats that as "no data").
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    throw new TypeError(`unmocked network call blocked in tests: ${String(input)}`);
  }) as typeof fetch;
});
