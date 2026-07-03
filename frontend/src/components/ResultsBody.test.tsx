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
  it("shows the ArtistList in Suggestions and only the matrix in Analytics, never both", () => {
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
      />
    );

    // Suggestions is the default tab: the ledger's sort control is visible,
    // the Analytics-only Discovery Matrix caption is not.
    expect(screen.getByText("sort by")).toBeInTheDocument();
    expect(screen.queryByText("discovery matrix")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));

    // Analytics: matrix visible, ledger's sort control gone. The Obscurity
    // Index block was removed from this tab entirely — the hero's compact
    // "obscurity index" readout (above the tabs) is now the only place the
    // score renders, so there's exactly one match, not two.
    expect(screen.getByText("discovery matrix")).toBeInTheDocument();
    expect(screen.getAllByText("obscurity index").length).toBe(1);
    expect(screen.queryByText("sort by")).not.toBeInTheDocument();
  });
});

describe("ResultsBody — Obscurity Index block removed from Analytics", () => {
  it("does not render the removed index block's seeds/candidates line or prose in Analytics", () => {
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
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));

    // The matrix is present...
    expect(screen.getByText("discovery matrix")).toBeInTheDocument();
    // ...but the "{N} seeds · {M} candidates" line — unique to the removed
    // block, never rendered by the hero's compact readout — is gone.
    expect(screen.queryByText(/seeds ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ candidates/)).not.toBeInTheDocument();
  });

  it("renders the obscurity index exactly once (hero only), even in Analytics", () => {
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
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));
    expect(screen.getAllByText("obscurity index")).toHaveLength(1);
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

describe("ResultsBody — Discovery Matrix shows the full result set", () => {
  it("plots all 25 artists, not just the first 10", () => {
    const artists = makeArtists(25);
    render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));

    for (let i = 0; i < 25; i++) {
      expect(screen.getByLabelText(`Artist ${i}`)).toBeInTheDocument();
    }
  });

  it("caps the matrix at 25 even if more candidates come back", () => {
    const artists = makeArtists(30);
    render(
      <ResultsBody
        username="alice"
        mode="artists"
        artists={artists}
        listArtists={artists}
        sortBy="composite"
        setSortBy={noop}
        depthScore={74}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "analytics" }));

    expect(screen.getByLabelText("Artist 24")).toBeInTheDocument();
    expect(screen.queryByLabelText("Artist 25")).not.toBeInTheDocument();
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
      />
    );
    expect(screen.queryByTestId("hero-picks")).not.toBeInTheDocument();
  });
});
