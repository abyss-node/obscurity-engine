import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ResultsTopBar from "./ResultsTopBar";
import type { Session } from "../lib/session";

const session: Session = { session_token: "t", username: "alice", user_id: "u-1" };

function noop() {}

const baseProps = {
  username: "bob",
  onReset: noop,
  mode: "artists" as const,
  setMode: noop,
  period: "blend",
  setPeriod: noop,
  appetite: "balanced",
  setAppetite: noop,
  onRefresh: noop,
  refreshDisabled: false,
  isRefreshing: false,
  shareState: "idle" as const,
  onShare: noop,
};

describe("ResultsTopBar — renders all controls", () => {
  it("renders the wordmark, username, mode chips, period chips, appetite slider, refresh, and share", () => {
    render(<ResultsTopBar {...baseProps} />);

    expect(screen.getByText("OBSCURITY ENGINE")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();

    expect(screen.getByText("artists")).toBeInTheDocument();
    expect(screen.getByText("tracks")).toBeInTheDocument();

    for (const label of ["BLEND", "YTD", "7D", "1M", "3M", "6M", "1Y", "ALL"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    expect(screen.getByLabelText("Discovery appetite")).toBeInTheDocument();
    expect(screen.getByText("Balanced")).toBeInTheDocument();

    expect(screen.getByTitle("refresh")).toBeInTheDocument();
    expect(screen.getByTitle("share")).toBeInTheDocument();
  });

  it("renders the period pills in the exact order BLEND, YTD, 7D, 1M, 3M, 6M, 1Y, ALL", () => {
    render(<ResultsTopBar {...baseProps} />);
    const periodLabels = ["BLEND", "YTD", "7D", "1M", "3M", "6M", "1Y", "ALL"];
    const buttons = screen
      .getAllByRole("button")
      .filter((btn) => periodLabels.includes(btn.textContent ?? ""));
    expect(buttons.map((btn) => btn.textContent)).toEqual(periodLabels);
  });

  it("does not render session/saved controls when logged out", () => {
    render(<ResultsTopBar {...baseProps} />);
    expect(screen.queryByText("saved")).not.toBeInTheDocument();
  });

  it("shows the session username and, once savedCount > 0, the saved nav item", () => {
    render(<ResultsTopBar {...baseProps} session={session} savedCount={3} />);
    expect(screen.getByTitle("log out")).toHaveTextContent("alice");
    expect(screen.getByText("saved")).toBeInTheDocument();
  });

  it("hides the saved nav item when logged in but savedCount is 0", () => {
    render(<ResultsTopBar {...baseProps} session={session} savedCount={0} />);
    expect(screen.getByTitle("log out")).toBeInTheDocument();
    expect(screen.queryByText("saved")).not.toBeInTheDocument();
  });
});

describe("ResultsTopBar — control wiring", () => {
  it("calls onReset when the wordmark or username is clicked", () => {
    const onReset = vi.fn();
    render(<ResultsTopBar {...baseProps} onReset={onReset} />);
    fireEvent.click(screen.getByText("OBSCURITY ENGINE"));
    fireEvent.click(screen.getByText("bob"));
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("calls setMode with the clicked mode", () => {
    const setMode = vi.fn();
    render(<ResultsTopBar {...baseProps} setMode={setMode} />);
    fireEvent.click(screen.getByText("tracks"));
    expect(setMode).toHaveBeenCalledWith("tracks");
  });

  it("calls setPeriod with the clicked period value", () => {
    const setPeriod = vi.fn();
    render(<ResultsTopBar {...baseProps} setPeriod={setPeriod} />);
    fireEvent.click(screen.getByText("7D"));
    expect(setPeriod).toHaveBeenCalledWith("7day");
  });

  it("calls setAppetite with the stop's value on slider change", () => {
    const setAppetite = vi.fn();
    render(<ResultsTopBar {...baseProps} setAppetite={setAppetite} />);
    fireEvent.change(screen.getByLabelText("Discovery appetite"), { target: { value: "3" } });
    expect(setAppetite).toHaveBeenCalledWith("high");
  });

  it("calls onRefresh when the refresh control is clicked, and disables it when refreshDisabled", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<ResultsTopBar {...baseProps} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTitle("refresh"));
    expect(onRefresh).toHaveBeenCalled();

    rerender(<ResultsTopBar {...baseProps} onRefresh={onRefresh} refreshDisabled />);
    expect(screen.getByTitle("refresh")).toBeDisabled();
  });

  it("calls onShare when the share control is clicked and reflects shareState in its label", () => {
    const onShare = vi.fn();
    const { rerender } = render(<ResultsTopBar {...baseProps} onShare={onShare} />);
    expect(screen.getByTitle("share")).toHaveTextContent("↑ share");
    fireEvent.click(screen.getByTitle("share"));
    expect(onShare).toHaveBeenCalled();

    rerender(<ResultsTopBar {...baseProps} onShare={onShare} shareState="copied" />);
    expect(screen.getByTitle("share")).toHaveTextContent("copied");

    // F4: PNG download + persisted link copy together — its own combined label.
    rerender(<ResultsTopBar {...baseProps} onShare={onShare} shareState="saved-copied" />);
    expect(screen.getByTitle("share")).toHaveTextContent("saved ✓ · link copied");
  });

  it("calls onShowSaved when the saved nav item is clicked", () => {
    const onShowSaved = vi.fn();
    render(<ResultsTopBar {...baseProps} session={session} savedCount={1} onShowSaved={onShowSaved} />);
    fireEvent.click(screen.getByText("saved"));
    expect(onShowSaved).toHaveBeenCalled();
  });

  it("calls onLogout when the session username is clicked", () => {
    const onLogout = vi.fn();
    render(<ResultsTopBar {...baseProps} session={session} onLogout={onLogout} />);
    fireEvent.click(screen.getByTitle("log out"));
    expect(onLogout).toHaveBeenCalled();
  });
});
