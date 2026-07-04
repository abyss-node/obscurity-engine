import { describe, it, expect } from "vitest";
import { classifyDiscoveryError, TIMEOUT_ERROR, NETWORK_ERROR } from "./discoveryError";

// Mirrors useDiscovery.test.ts's coverage of the same branches, but exercised
// directly against the extracted pure function (no fetch/hook plumbing).

describe("classifyDiscoveryError", () => {
  it("404 with a parseable app-error body -> USER_NOT_FOUND", () => {
    const detail = 'Last.fm user "nosuchuser123" not found. Check the spelling.';
    expect(classifyDiscoveryError(404, detail)).toBe(`[ERR] USER_NOT_FOUND — ${detail}`);
  });

  it("bare 404 with no parseable app-error body (detail=null) -> generic SONAR_FAILURE with HTTP status text", () => {
    expect(classifyDiscoveryError(404, null)).toBe("[ERR] SONAR_FAILURE — HTTP 404");
  });

  it("500 with a rate-limit-matching detail -> the rate-limit copy", () => {
    const detail = "Discovery failed: Last.fm rate limit exceeded";
    expect(classifyDiscoveryError(500, detail)).toBe(
      "[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry."
    );
  });

  it("500 with a non-matching detail -> the generic retry copy, with detail interpolated", () => {
    const detail = "Discovery failed: something exploded";
    expect(classifyDiscoveryError(500, detail)).toBe(
      `[ERR] SONAR_FAILURE — The discovery service hit an error; retry in a moment. (${detail})`
    );
  });

  it("500 with a null detail -> the generic retry copy using the HTTP status text", () => {
    expect(classifyDiscoveryError(500, null)).toBe(
      "[ERR] SONAR_FAILURE — The discovery service hit an error; retry in a moment. (HTTP 500)"
    );
  });

  it("other non-OK status (e.g. 400) -> SONAR_FAILURE with the raw detail", () => {
    expect(classifyDiscoveryError(400, "bad request")).toBe("[ERR] SONAR_FAILURE — bad request");
  });

  it("other non-OK status with no detail -> SONAR_FAILURE with the HTTP status text", () => {
    expect(classifyDiscoveryError(403, null)).toBe("[ERR] SONAR_FAILURE — HTTP 403");
  });

  it("various 5xx busy-signature phrasings all match the rate-limit copy", () => {
    const phrasings = [
      "error decoding response body",
      "service temporarily unavailable",
      "failed to fetch upstream",
      "backend unavailable right now",
    ];
    for (const detail of phrasings) {
      expect(classifyDiscoveryError(502, detail)).toBe(
        "[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry."
      );
    }
  });

  // Timeout / network-level failures happen below the HTTP layer (no status
  // code exists yet) so they can't be expressed as classifyDiscoveryError(status,
  // detail) — they're exported as standalone constants instead, and every
  // caller's catch block (useDiscovery.ts, useCompare.ts) must use these
  // exact strings rather than re-deriving their own copy.
  it("exports the exact timeout and network-failure copy used by callers' catch blocks", () => {
    expect(TIMEOUT_ERROR).toBe(
      "[ERR] SONAR_FAILURE — Request timed out after 90s. The service may be busy; retry."
    );
    expect(NETWORK_ERROR).toBe(
      "[ERR] SONAR_FAILURE — Couldn't reach the discovery service. It may be starting up or blocked; retry in a moment."
    );
  });
});
