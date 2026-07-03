import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SavedView from "./SavedView";

const fetchSavedMock = vi.fn();
const postEventMock = vi.fn().mockResolvedValue(true);

vi.mock("@/lib/me", () => ({
  fetchSaved: (...args: unknown[]) => fetchSavedMock(...args),
}));
vi.mock("@/lib/events", () => ({
  postEvent: (...args: unknown[]) => postEventMock(...args),
}));

beforeEach(() => {
  fetchSavedMock.mockReset();
  postEventMock.mockClear();
});

describe("SavedView states", () => {
  it("shows a loading indicator while the fetch is in flight", () => {
    fetchSavedMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SavedView onClose={() => {}} />);
    expect(screen.getByText(/loading saved artists/i)).toBeInTheDocument();
  });

  it("shows the EmptyState saved-empty variant when there are zero saves", async () => {
    fetchSavedMock.mockResolvedValue([]);
    render(<SavedView onClose={() => {}} />);
    expect(await screen.findByText(/nothing saved yet/i)).toBeInTheDocument();
  });

  it("lists saved artists on success and reports the count", async () => {
    const onCountChange = vi.fn();
    fetchSavedMock.mockResolvedValue([
      { rec_id: "r1", artist_name: "Duster" },
      { rec_id: "r2", artist_name: "Grouper" },
    ]);
    render(<SavedView onClose={() => {}} onCountChange={onCountChange} />);

    expect(await screen.findByText("Duster")).toBeInTheDocument();
    expect(screen.getByText("Grouper")).toBeInTheDocument();
    expect(onCountChange).toHaveBeenCalledWith(2);
  });

  it("shows the house ErrorState with a retry on fetch failure", async () => {
    fetchSavedMock.mockRejectedValue(new Error("network down"));
    render(<SavedView onClose={() => {}} />);

    expect(await screen.findByText("[ERR] REQUEST_FAILED")).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();

    fetchSavedMock.mockResolvedValue([{ rec_id: "r1", artist_name: "Duster" }]);
    fireEvent.click(screen.getByText(/retry/i));
    expect(await screen.findByText("Duster")).toBeInTheDocument();
  });

  it("removes a row optimistically and calls onCountChange after a confirmed unsave", async () => {
    const onCountChange = vi.fn();
    fetchSavedMock.mockResolvedValue([{ rec_id: "r1", artist_name: "Duster" }]);
    render(<SavedView onClose={() => {}} onCountChange={onCountChange} />);

    await screen.findByText("Duster");
    fireEvent.click(screen.getByText("remove"));

    await waitFor(() => expect(screen.queryByText("Duster")).not.toBeInTheDocument());
    expect(postEventMock).toHaveBeenCalledWith({ rec_id: "r1", type: "unsave" });
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
  });

  it("calls onClose when the close control is clicked", async () => {
    fetchSavedMock.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<SavedView onClose={onClose} />);
    await screen.findByText(/nothing saved yet/i);
    fireEvent.click(screen.getByText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
