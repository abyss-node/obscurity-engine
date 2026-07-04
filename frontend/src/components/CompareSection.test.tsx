import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CompareSection from "./CompareSection";
import type { Artist } from "../lib/types";

// Fetch-stubbing pattern matches useShare.test.ts (vi.stubGlobal("fetch", ...)
// + vi.restoreAllMocks()/vi.unstubAllGlobals() in afterEach).

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    name: "Duster",
    stickiness_score: 40,
    conviction_score: 120,
    composite_score: 60,
    total_listeners: 8000,
    top_tags: ["slowcore"],
    source_seeds: [{ name: "Bedhead", percentile: 12 }],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSection(sharerArtists: Artist[] = [makeArtist()]) {
  return render(
    <CompareSection
      sharerUsername="alice"
      period="blend"
      appetite="balanced"
      sharerArtists={sharerArtists}
    />
  );
}

describe("CompareSection", () => {
  it("renders the username input and compare button", () => {
    renderSection();
    expect(screen.getByPlaceholderText("your last.fm username")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /compare/i })).toBeInTheDocument();
  });

  it("self-username guard prevents any fetch call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    fireEvent.change(screen.getByPlaceholderText("your last.fm username"), {
      target: { value: "  Alice  " }, // same as sharer, different case/whitespace
    });
    fireEvent.click(screen.getByRole("button", { name: /compare/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/try a different one to compare/i)).toBeInTheDocument();
  });

  it("success path renders the taste-match percentage and at least one overlap chip", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        artists: [makeArtist({ name: "duster" })], // matches sharer's "Duster" case-insensitively
        top_genres: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection([makeArtist({ name: "Duster" })]);

    fireEvent.change(screen.getByPlaceholderText("your last.fm username"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: /compare/i }));

    await waitFor(() => expect(screen.getByText(/taste match/i)).toBeInTheDocument());
    expect(screen.getByText("100% taste match")).toBeInTheDocument();
    expect(screen.getByText("Duster")).toBeInTheDocument();
  });

  it("404-with-app-body renders the USER_NOT_FOUND error copy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Last.fm user "bob" not found. Check the spelling.' }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    fireEvent.change(screen.getByPlaceholderText("your last.fm username"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: /compare/i }));

    await waitFor(() =>
      expect(screen.getByText(/\[ERR\] USER_NOT_FOUND/)).toBeInTheDocument()
    );
  });

  it("disables the compare button while the request is pending", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    fireEvent.change(screen.getByPlaceholderText("your last.fm username"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: /compare/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /compare/i })).toBeDisabled());

    resolveFetch({ ok: true, json: async () => ({ artists: [], top_genres: [] }) });
  });
});
