import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import LastfmAuthCallback from "./page";

const exchangeTokenMock = vi.fn();
vi.mock("@/lib/session", () => ({
  exchangeToken: (...args: unknown[]) => exchangeTokenMock(...args),
}));

let replaceMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

function setSearch(search: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, search, replace: replaceMock },
  });
}

beforeEach(() => {
  originalLocation = window.location;
  replaceMock = vi.fn();
  exchangeTokenMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  vi.useRealTimers();
});

describe("/auth/lastfm callback", () => {
  it("redirects home immediately when there's no ?token=", () => {
    setSearch("");
    render(<LastfmAuthCallback />);
    expect(replaceMock).toHaveBeenCalledWith("/");
    expect(exchangeTokenMock).not.toHaveBeenCalled();
  });

  it("exchanges the token and redirects home on success, showing LoadingState meanwhile", async () => {
    setSearch("?token=abc123");
    exchangeTokenMock.mockResolvedValue({ session_token: "s", username: "alice", user_id: "u1" });
    render(<LastfmAuthCallback />);

    // LoadingState is showing during the exchange
    expect(screen.getByText(/analyzing your library/i)).toBeInTheDocument();

    await waitFor(() => expect(exchangeTokenMock).toHaveBeenCalledWith("abc123"));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
  });

  it("shows an [ERR] AUTH_FAILURE state and redirects home after a failed exchange", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setSearch("?token=bad");
    exchangeTokenMock.mockResolvedValue(null);
    render(<LastfmAuthCallback />);

    await vi.waitFor(() => expect(screen.getByText(/AUTH_FAILURE/)).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(2000);
    expect(replaceMock).toHaveBeenCalledWith("/");
  });
});
