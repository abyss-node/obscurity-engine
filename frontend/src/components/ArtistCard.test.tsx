import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ArtistCard from "./ArtistCard";
import type { Artist } from "../app/page";
import type { Session } from "../lib/session";

const postEventMock = vi.fn().mockResolvedValue(true);
vi.mock("../lib/events", () => ({
  postEvent: (...args: unknown[]) => postEventMock(...args),
}));

const session: Session = { session_token: "t", username: "alice", user_id: "u-1" };

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

// Hidden-when-unsupported: the save/dismiss action row must render only when
// session + persistence:true + rec_id all hold simultaneously.
describe("ArtistCard — save/dismiss visibility matrix", () => {
  it("hides persist actions when logged out (persistence:false backend / no session) — zero UI change", () => {
    const artist = makeArtist({ rec_id: null });
    render(
      <ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={null} persistence={false} />
    );
    expect(screen.queryByText("save")).not.toBeInTheDocument();
    expect(screen.queryByText("dismiss")).not.toBeInTheDocument();
    expect(screen.queryByTestId("persist-actions")).not.toBeInTheDocument();
  });

  it("hides persist actions when logged out even if persistence:true and rec_id present", () => {
    const artist = makeArtist({ rec_id: "rec-1" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={null} persistence={true} />);
    expect(screen.queryByTestId("persist-actions")).not.toBeInTheDocument();
  });

  it("hides persist actions when logged in but persistence:false", () => {
    const artist = makeArtist({ rec_id: "rec-1" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={session} persistence={false} />);
    expect(screen.queryByTestId("persist-actions")).not.toBeInTheDocument();
  });

  it("hides persist actions when logged in + persistence:true but rec_id is null (cache-hit gap)", () => {
    const artist = makeArtist({ rec_id: null });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={session} persistence={true} />);
    expect(screen.queryByTestId("persist-actions")).not.toBeInTheDocument();
  });

  it("shows save/dismiss only when session + persistence:true + rec_id all hold", () => {
    const artist = makeArtist({ rec_id: "rec-1" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={session} persistence={true} />);
    expect(screen.getByTestId("persist-actions")).toBeInTheDocument();
    expect(screen.getByText("save")).toBeInTheDocument();
    expect(screen.getByText("dismiss")).toBeInTheDocument();
  });
});

describe("ArtistCard — save/dismiss wiring", () => {
  const artist = makeArtist({ rec_id: "rec-1" });

  it("calls onSave when the save action is clicked", () => {
    const onSave = vi.fn();
    render(
      <ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={session} persistence onSave={onSave} />
    );
    fireEvent.click(screen.getByText("save"));
    expect(onSave).toHaveBeenCalled();
  });

  it("shows the filled saved marker and an unsave control when saved=true", () => {
    const onUnsave = vi.fn();
    render(
      <ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={session} persistence saved onUnsave={onUnsave} />
    );
    expect(screen.queryByText("save")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("saved"));
    expect(onUnsave).toHaveBeenCalled();
  });

  it("calls onDismiss when the dismiss action is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} session={session} persistence onDismiss={onDismiss} />
    );
    fireEvent.click(screen.getByText("dismiss"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("ArtistCard — click_listen/share beacons", () => {
  it("fires click_listen with rec_id/run_id/target on a listen link click, with no auth requirement", () => {
    const artist = makeArtist({ rec_id: "rec-1" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} runId="run-9" session={null} persistence={false} />);

    fireEvent.click(screen.getByText("Last.fm"));

    expect(postEventMock).toHaveBeenCalledWith({
      rec_id: "rec-1",
      run_id: "run-9",
      type: "click_listen",
      target: "lastfm",
    });
  });

  it("fires a share event (no target) on the WhatsApp link", () => {
    const artist = makeArtist({ rec_id: "rec-1" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} />);
    fireEvent.click(screen.getByText("WhatsApp"));
    expect(postEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ rec_id: "rec-1", type: "share", target: undefined })
    );
  });

  it("does not fire any event when the artist has no rec_id", () => {
    const artist = makeArtist({ rec_id: null });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} />);
    fireEvent.click(screen.getByText("Last.fm"));
    expect(postEventMock).not.toHaveBeenCalled();
  });
});

describe("ArtistCard — Bandcamp link", () => {
  it("falls back to an encoded Bandcamp search URL when no resolved bandcamp_url is present", () => {
    const artist = makeArtist({ rec_id: "rec-1", name: "Duster & Friends", bandcamp_url: undefined });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} />);
    const link = screen.getByText("Bandcamp").closest("a");
    expect(link).toHaveAttribute(
      "href",
      "https://bandcamp.com/search?q=Duster%20%26%20Friends&item_type=b"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("prefers a backend-resolved exact bandcamp_url over the search fallback", () => {
    const artist = makeArtist({ rec_id: "rec-1", bandcamp_url: "https://duster.bandcamp.com" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} />);
    const link = screen.getByText("Bandcamp").closest("a");
    expect(link).toHaveAttribute("href", "https://duster.bandcamp.com");
  });

  it("fires click_listen with target=bandcamp on click", () => {
    const artist = makeArtist({ rec_id: "rec-1" });
    render(<ArtistCard artist={artist} rank={1} expanded onToggle={() => {}} runId="run-9" />);
    fireEvent.click(screen.getByText("Bandcamp"));
    expect(postEventMock).toHaveBeenCalledWith({
      rec_id: "rec-1",
      run_id: "run-9",
      type: "click_listen",
      target: "bandcamp",
    });
  });
});
