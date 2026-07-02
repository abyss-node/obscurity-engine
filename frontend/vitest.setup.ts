import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount anything rendered via @testing-library/react between tests so the
// jsdom document stays clean for the next case.
afterEach(() => {
  cleanup();
});
