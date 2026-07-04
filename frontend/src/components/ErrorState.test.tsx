import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorState from "./ErrorState";

// F3: the nonexistent-user (USER_NOT_FOUND) framing must read as permanent —
// no "wait"/"retry in a moment" language — while the existing rate-limit
// framing (SONAR_FAILURE) keeps its retry-suggesting copy unchanged.
describe("ErrorState — code-aware header and copy", () => {
  it("renders a dynamic header from the leading [ERR] CODE token", () => {
    render(
      <ErrorState
        error="[ERR] USER_NOT_FOUND — That Last.fm username doesn't exist. Check the spelling and try again."
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText("[ERR] USER_NOT_FOUND")).toBeInTheDocument();
  });

  it("does not suggest a transient/retry framing for USER_NOT_FOUND", () => {
    render(
      <ErrorState
        error="[ERR] USER_NOT_FOUND — That Last.fm username doesn't exist. Check the spelling and try again."
        onRetry={vi.fn()}
      />
    );
    const prose = screen.getByText(/doesn't exist/i).textContent?.toLowerCase() ?? "";
    expect(prose).not.toMatch(/wait/);
    expect(prose).not.toMatch(/retry in a moment/);
  });

  it("keeps the rate-limit message's retry-suggesting language unchanged", () => {
    render(
      <ErrorState
        error="[ERR] SONAR_FAILURE — Last.fm is rate-limiting us right now. Wait a few seconds and retry."
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText("[ERR] SONAR_FAILURE")).toBeInTheDocument();
    expect(screen.getByText(/rate-limiting/i).textContent?.toLowerCase()).toMatch(/wait/);
  });

  it("defaults the header to REQUEST_FAILED for untagged/legacy error strings", () => {
    render(<ErrorState error="Some untagged error message" onRetry={vi.fn()} />);
    expect(screen.getByText("[ERR] REQUEST_FAILED")).toBeInTheDocument();
    expect(screen.getByText("Some untagged error message")).toBeInTheDocument();
  });
});
