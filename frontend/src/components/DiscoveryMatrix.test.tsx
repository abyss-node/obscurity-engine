import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DiscoveryMatrix from "./DiscoveryMatrix";
import type { Artist } from "../app/page";

function makeArtist(overrides: Partial<Artist> & { name: string }): Artist {
  return {
    stickiness_score: 0.5,
    conviction_score: 0.7,
    composite_score: 1,
    total_listeners: 5000,
    top_tags: ["shoegaze"],
    source_seeds: [{ name: "Seed A", percentile: 90 }],
    ...overrides,
  };
}

// A tight cluster of dual-signal (always-on-label) artists with long-ish
// names, similar to what QA saw overlapping on a 390px viewport.
function denseDualArtists(count: number): Artist[] {
  return Array.from({ length: count }, (_, i) =>
    makeArtist({
      name: `Long Artist Name ${i}`,
      cross_validated: true,
      // Similar conviction/stickiness -> clustered x/y in plot-% space.
      conviction_score: 65 + i,
      stickiness_score: 40 + i,
      total_listeners: 5000,
    })
  );
}

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

function mockPlotRect(width: number, height = 400) {
  HTMLElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {},
  });
}

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

describe("DiscoveryMatrix — label collisions", () => {
  it("without a real measured layout (jsdom default), falls through to legacy labelDy behavior and shows every dual-signal label", () => {
    const artists = denseDualArtists(6);
    render(<DiscoveryMatrix artists={artists} />);

    for (const a of artists) {
      // Each dual-signal artist's label span renders unconditionally
      // (legacy behavior) even though jsdom's default getBoundingClientRect
      // returns a zero-size rect (no ResizeObserver/layout in this env).
      expect(screen.getAllByText(a.name).length).toBeGreaterThan(0);
    }
  });

  it("at a narrow measured plot width, hides some overlapping dual-signal labels but keeps the higher-ranked (earlier) ones", () => {
    mockPlotRect(320);
    const artists = denseDualArtists(8);
    render(<DiscoveryMatrix artists={artists} />);

    // The first artist (rank 0, highest priority) must always keep its
    // persistent label.
    expect(screen.getByText(artists[0].name)).toBeInTheDocument();

    const visibleLabelCount = artists.filter(
      (a) => screen.queryByText(a.name) !== null
    ).length;
    expect(visibleLabelCount).toBeLessThan(artists.length);
  });

  it("a dual-signal label hidden by collision resolution still appears on hover/tap of its own dot", () => {
    mockPlotRect(320);
    const artists = denseDualArtists(8);
    render(<DiscoveryMatrix artists={artists} />);

    const hiddenArtist = artists.find((a) => screen.queryByText(a.name) === null);
    expect(hiddenArtist).toBeTruthy();
    if (!hiddenArtist) return;

    const dot = screen.getByLabelText(hiddenArtist.name);
    fireEvent.mouseEnter(dot);

    expect(screen.getByText(hiddenArtist.name)).toBeInTheDocument();
  });

  it("at a wide measured plot width, all dual-signal labels remain visible", () => {
    mockPlotRect(1200);
    const artists = denseDualArtists(8);
    render(<DiscoveryMatrix artists={artists} />);

    for (const a of artists) {
      expect(screen.getByText(a.name)).toBeInTheDocument();
    }
  });
});
