import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ResultsBody from "./ResultsBody";
import type { Artist } from "../app/page";

vi.mock("../lib/events", () => ({
  postEvent: vi.fn().mockResolvedValue(true),
}));

function makeArtists(count: number): Artist[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Artist ${i}`,
    stickiness_score: 0.5,
    conviction_score: 0.7,
    composite_score: 1 - i / count,
    total_listeners: 5000 + i,
    top_tags: ["shoegaze"],
    source_seeds: [{ name: "Seed A", percentile: 90 }],
  }));
}

function noop() {}

describe("ResultsBody — tab switching splits content correctly", () => {
  it("shows the ArtistList in Suggestions and the index+matrix in Analytics, never both", () => {
    const artists = makeArtists(5);
    render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse="devoted listener"
        activeSeedCount={12}
      />
    );

    // Suggestions is the default tab: the ledger's sort control is visible,
    // the Analytics-only Discovery Matrix caption is not.
    expect(screen.getByText("sort by")).toBeInTheDocument();
    expect(screen.queryByText("discovery matrix")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));

    // Analytics: index block + matrix visible, the ledger's sort control gone.
    // (The hero's own compact "obscurity index" readout also renders — it's
    // above the tabs, outside either tab's content — so there are 2 matches.)
    expect(screen.getByText("discovery matrix")).toBeInTheDocument();
    expect(screen.getAllByText("obscurity index").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("sort by")).not.toBeInTheDocument();
  });
});

describe("ResultsBody — tab resets on identity change", () => {
  it("resets to Suggestions when the username changes", () => {
    const artists = makeArtists(5);
    const { rerender } = render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse={null}
        activeSeedCount={12}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));
    expect(screen.getByText("discovery matrix")).toBeInTheDocument();

    rerender(
      <ResultsBody
        username="bob"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse={null}
        activeSeedCount={12}
      />
    );

    expect(screen.getByText("sort by")).toBeInTheDocument();
    expect(screen.queryByText("discovery matrix")).not.toBeInTheDocument();
  });
});

describe("ResultsBody — matrix dot click", () => {
  it("switches to Suggestions and focuses the clicked artist", () => {
    const artists = makeArtists(5);
    const onFocusArtist = vi.fn();
    render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse={null}
        activeSeedCount={12}
        onFocusArtist={onFocusArtist}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));
    fireEvent.click(screen.getByLabelText("Artist 0"));

    expect(onFocusArtist).toHaveBeenCalledWith("Artist 0");
    // Back on Suggestions — the ledger is visible again.
    expect(screen.getByText("sort by")).toBeInTheDocument();
  });
});

describe("ResultsBody — hero gating", () => {
  it("does not render hero picks in tracks mode", () => {
    const artists = makeArtists(5);
    render(
      <ResultsBody
        username="alice"
        mode="tracks"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse={null}
        activeSeedCount={12}
      />
    );
    expect(screen.queryByTestId("hero-picks")).not.toBeInTheDocument();
  });

  it("renders hero picks in artists mode with >= 3 results", () => {
    const artists = makeArtists(5);
    render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse={null}
        activeSeedCount={12}
      />
    );
    expect(screen.getByTestId("hero-picks")).toBeInTheDocument();
  });

  it("hides hero picks in artists mode with < 3 results", () => {
    const artists = makeArtists(2);
    render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
        depthProse={null}
        activeSeedCount={12}
      />
    );
    expect(screen.queryByTestId("hero-picks")).not.toBeInTheDocument();
  });
});
