import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HeroPicks from "./HeroPicks";
import type { Artist } from "../app/page";

const postEventMock = vi.fn().mockResolvedValue(true);
vi.mock("../lib/events", () => ({
  postEvent: (...args: unknown[]) => postEventMock(...args),
}));

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    name: "Duster",
    stickiness_score: 0.5,
    conviction_score: 0.7,
    composite_score: 0.6,
    total_listeners: 12000,
    top_tags: ["slowcore"],
    source_seeds: [{ name: "Bedroom Eyes", percentile: 90 }],
    ...overrides,
  };
}

beforeEach(() => {
  postEventMock.mockClear();
});

describe("HeroPicks — top-3 selection", () => {
  it("hides entirely (renders nothing) with fewer than 3 artists", () => {
    const artists = [makeArtist({ name: "A" }), makeArtist({ name: "B" })];
    const { container } = render(<HeroPicks artists={artists} depthScore={50} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty artist list", () => {
    const { container } = render(<HeroPicks artists={[]} depthScore={50} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the top 3 by composite_score, in descending order, ignoring array order", () => {
    const artists = [
      makeArtist({ name: "Low", composite_score: 0.1 }),
      makeArtist({ name: "Highest", composite_score: 0.9 }),
      makeArtist({ name: "Mid", composite_score: 0.5 }),
      makeArtist({ name: "SecondHighest", composite_score: 0.8 }),
      makeArtist({ name: "ThirdHighest", composite_score: 0.6 }),
    ];
    render(<HeroPicks artists={artists} depthScore={50} />);

    // Only the top 3 by composite_score render — the two lowest are excluded.
    expect(screen.getByText("Highest")).toBeInTheDocument();
    expect(screen.getByText("SecondHighest")).toBeInTheDocument();
    expect(screen.getByText("ThirdHighest")).toBeInTheDocument();
    expect(screen.queryByText("Mid")).not.toBeInTheDocument();
    expect(screen.queryByText("Low")).not.toBeInTheDocument();

    // Card #1 (rank "01") is the highest composite score.
    const ranks = screen.getAllByText(/^0[1-3]$/);
    expect(ranks).toHaveLength(3);
    expect(ranks[0].textContent).toBe("01");
  });

  it("shows the dual-signal marker only for cross_validated picks", () => {
    const artists = [
      makeArtist({ name: "A", composite_score: 0.9, cross_validated: true }),
      makeArtist({ name: "B", composite_score: 0.8, cross_validated: false }),
      makeArtist({ name: "C", composite_score: 0.7 }),
    ];
    render(<HeroPicks artists={artists} depthScore={50} />);
    expect(screen.getAllByText("✦ dual-signal")).toHaveLength(1);
  });

  it("hides the compact obscurity-index readout when depthScore is 0 (e.g. a shared view)", () => {
    const artists = [
      makeArtist({ name: "A", composite_score: 0.9 }),
      makeArtist({ name: "B", composite_score: 0.8 }),
      makeArtist({ name: "C", composite_score: 0.7 }),
    ];
    render(<HeroPicks artists={artists} depthScore={0} />);
    expect(screen.queryByText("obscurity index")).not.toBeInTheDocument();
  });
});

describe("HeroPicks — listen link click_listen beacons", () => {
  const artists = [
    makeArtist({ name: "A", composite_score: 0.9, rec_id: "rec-a" }),
    makeArtist({ name: "B", composite_score: 0.8, rec_id: "rec-b" }),
    makeArtist({ name: "C", composite_score: 0.7, rec_id: "rec-c" }),
  ];

  it("fires click_listen with rec_id/run_id/target on a Last.fm link click", () => {
    render(<HeroPicks artists={artists} depthScore={50} runId="run-9" />);
    fireEvent.click(screen.getAllByText("Last.fm ↗")[0]);
    expect(postEventMock).toHaveBeenCalledWith({
      rec_id: "rec-a",
      run_id: "run-9",
      type: "click_listen",
      target: "lastfm",
    });
  });

  it("does not fire an event when the artist has no rec_id", () => {
    const noRecArtists = artists.map((a) => ({ ...a, rec_id: null }));
    render(<HeroPicks artists={noRecArtists} depthScore={50} />);
    fireEvent.click(screen.getAllByText("Spotify ↗")[0]);
    expect(postEventMock).not.toHaveBeenCalled();
  });
});
