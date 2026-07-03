import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
// Adds the toBeInTheDocument()/etc jest-dom matchers used by P1-B's RTL
// component tests (ArtistCard, SavedView, the /auth/lastfm callback).
import "@testing-library/jest-dom/vitest";

// Unmount anything rendered via @testing-library/react between tests so the
// jsdom document stays clean for the next case.
afterEach(() => {
  cleanup();
});
