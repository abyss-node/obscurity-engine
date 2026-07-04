import { describe, it, expect } from "vitest";
import { countryFromTags, isGeoTag, formatGeoTag, firstGenreTag } from "./geoTags";

describe("full country-name tags are geo, not genre (2026-07-04 prod report)", () => {
  // Last.fm serves standalone "India" / "United Kingdom" tags; these slipped
  // through isGeoTag (only "indian"/"uk" were listed) and got rendered as a
  // band's main genre.
  it("treats 'India' and 'United Kingdom' as geo tags", () => {
    expect(isGeoTag("India")).toBe(true);
    expect(isGeoTag("United Kingdom")).toBe(true);
  });

  it("never serves a country name as the main genre", () => {
    expect(firstGenreTag(["India", "sufi rock", "singer-songwriter"])).toBe("sufi rock");
    expect(firstGenreTag(["United Kingdom", "post-punk"])).toBe("post-punk");
  });

  it("falls back to the country tag only when there is nothing else", () => {
    expect(firstGenreTag(["India"])).toBe("India");
  });

  it("canonicalizes full country names for the geo pill", () => {
    expect(countryFromTags(["United Kingdom", "post-punk"])).toBe("uk");
    expect(countryFromTags(["indie", "India"])).toBe("india");
    expect(countryFromTags(["United States", "emo"])).toBe("usa");
  });

  it("covers the newly added south-asian adjectives", () => {
    expect(isGeoTag("pakistani")).toBe(true);
    expect(countryFromTags(["pakistani folk"])).toBe("pakistan");
  });
});

describe("countryFromTags — pass 1 (whole-tag match, unchanged precedence)", () => {
  it("resolves a standalone country-adjective tag to its canonical country", () => {
    expect(countryFromTags(["shoegaze", "swedish"])).toBe("sweden");
  });

  it("resolves a standalone country-name tag directly", () => {
    expect(countryFromTags(["indie rock", "germany"])).toBe("germany");
  });

  it("prefers the first whole-tag geo match over a later compound-tag hit", () => {
    // "german" is a whole-tag match; "swedish death metal" is only a
    // compound hit further down the list — pass 1 must win regardless of
    // tag order priority between passes.
    expect(countryFromTags(["german", "swedish death metal"])).toBe("germany");
  });

  it("returns null when no tag carries any geo signal", () => {
    expect(countryFromTags(["death metal", "grindcore"])).toBeNull();
  });
});

describe("countryFromTags — pass 2 (compound-tag token detection)", () => {
  it("extracts a country adjective embedded in a compound tag", () => {
    expect(countryFromTags(["swedish death metal"])).toBe("sweden");
  });

  it("handles a different compound-tag shape (adjective-first genre pairing)", () => {
    expect(countryFromTags(["french coldwave"])).toBe("france");
  });

  it("handles adjectives with a genre suffix in another common position", () => {
    expect(countryFromTags(["japanese noise rock"])).toBe("japan");
  });

  it("resolves 'irish folk' to ireland via token match", () => {
    expect(countryFromTags(["irish folk"])).toBe("ireland");
  });

  it("does NOT false-positive on a substring inside a longer word (britpop)", () => {
    // "britpop" must never be treated as containing "brit"/"british" —
    // token-boundary matching only.
    expect(countryFromTags(["britpop"])).toBeNull();
  });

  it("returns null for a plain genre tag with no geo token at all", () => {
    expect(countryFromTags(["death metal"])).toBeNull();
  });

  it("splits on hyphens as well as spaces", () => {
    expect(countryFromTags(["swedish-death-metal"])).toBe("sweden");
  });

  it("scans multiple tags in order and returns the first compound hit", () => {
    expect(countryFromTags(["death metal", "swedish black metal", "french coldwave"])).toBe(
      "sweden"
    );
  });
});

describe("isGeoTag / formatGeoTag — unchanged behavior sanity checks", () => {
  it("still whole-tag matches known geo tags", () => {
    expect(isGeoTag("swedish")).toBe(true);
    expect(isGeoTag("britpop")).toBe(false);
  });

  it("still formats acronyms and titlecase correctly", () => {
    expect(formatGeoTag("uk")).toBe("UK");
    expect(formatGeoTag("sweden")).toBe("Sweden");
  });
});
