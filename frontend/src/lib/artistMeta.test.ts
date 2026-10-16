import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artistMetaUrl,
  fetchArtistMeta,
  formatArtistOrigin,
  formatArtistType,
  metaRequestNames,
} from "./artistMeta";
import { countryFromTags } from "./geoTags";
import type { ArtistMeta } from "./types";

const m = (o: Partial<ArtistMeta> = {}): ArtistMeta => ({
  country_iso2: null, area_name: null, begin_year: null, artist_type: null, ...o,
});

afterEach(() => vi.unstubAllGlobals());

describe("formatArtistType", () => {
  it("maps known types and lowercases unknown ones", () => {
    expect(formatArtistType("Group")).toBe("band");
    expect(formatArtistType("Person")).toBe("solo");
    expect(formatArtistType("Orchestra")).toBe("orchestra");
    expect(formatArtistType("Choir")).toBe("choir");
    expect(formatArtistType("Character")).toBe("character");
    expect(formatArtistType(null)).toBeNull();
    expect(formatArtistType("  ")).toBeNull();
  });
});

describe("formatArtistOrigin", () => {
  it("renders every part that exists", () => {
    expect(formatArtistOrigin(m({ country_iso2: "SE", begin_year: 2014, artist_type: "Group" }), null))
      .toBe("Sweden · 2014 · band");
  });
  it("omits missing parts", () => {
    expect(formatArtistOrigin(m({ country_iso2: "SE", artist_type: "Group" }), null)).toBe("Sweden · band");
    expect(formatArtistOrigin(m({ country_iso2: "SE" }), null)).toBe("Sweden");
    expect(formatArtistOrigin(m({ country_iso2: "SE", begin_year: 1999 }), null)).toBe("Sweden · 1999");
  });
  it("shows year and type without a country when there is no country anywhere", () => {
    expect(formatArtistOrigin(m({ begin_year: 2001, artist_type: "Person" }), null)).toBe("2001 · solo");
  });
  it("returns empty string when nothing is known", () => {
    expect(formatArtistOrigin(null, null)).toBe("");
    expect(formatArtistOrigin(undefined, undefined)).toBe("");
    expect(formatArtistOrigin(m(), null)).toBe("");
  });
  it("falls back to area_name for pseudo-codes Intl rejects", () => {
    expect(formatArtistOrigin(m({ country_iso2: "XW", area_name: "[Worldwide]" }), null)).toBe("[Worldwide]");
    expect(formatArtistOrigin(m({ country_iso2: "XE", area_name: "[Europe]", artist_type: "Group" }), null))
      .toBe("[Europe] · band");
  });
  it("falls back to area_name when Intl throws", () => {
    const RealIntl = Intl;
    vi.stubGlobal("Intl", {
      ...RealIntl,
      DisplayNames: class {
        constructor() {
          throw new RangeError("unsupported");
        }
      },
    });
    expect(formatArtistOrigin(m({ country_iso2: "SE", area_name: "Sweden" }), null)).toBe("Sweden");
  });
  it("falls through to the tag guess when a pseudo-code has no area_name", () => {
    expect(formatArtistOrigin(m({ country_iso2: "XW" }), "sweden")).toBe("Sweden");
  });
  it("prefers the MB country over the tag guess", () => {
    expect(formatArtistOrigin(m({ country_iso2: "DE" }), countryFromTags(["swedish death metal"]))).toBe("Germany");
  });
  it("keeps the tag guess where MB has no country, and adds MB year/type to it", () => {
    const tag = countryFromTags(["swedish death metal"]);
    expect(formatArtistOrigin(null, tag)).toBe("Sweden");
    expect(formatArtistOrigin(m({ begin_year: 1987, artist_type: "Group" }), tag)).toBe("Sweden · 1987 · band");
  });
});

describe("request building", () => {
  it("encodes names with commas, ampersands and plus signs as repeated params", () => {
    const url = artistMetaUrl("http://b", ["Crosby, Stills & Nash", "AC+DC", "Plain"]);
    const qs = new URL(url).searchParams;
    expect(qs.getAll("name")).toEqual(["Crosby, Stills & Nash", "AC+DC", "Plain"]);
    expect(url).toContain("AC%2BDC");
    expect(url).toContain("%26");
    expect(url).toContain("%2C");
  });
  it("dedupes, drops blanks and over-long names, caps at 25", () => {
    const many = Array.from({ length: 40 }, (_, i) => `a${i}`);
    expect(metaRequestNames(many)).toHaveLength(25);
    expect(metaRequestNames(["a", "a", " ", "x".repeat(201), "b"])).toEqual(["a", "b"]);
  });
});

describe("fetchArtistMeta", () => {
  const stub = (res: Partial<Response> | Error) =>
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res as Response;
    }));
  it("parses a 200", async () => {
    stub({ ok: true, status: 200, json: async () => ({ meta: { A: null }, pending: ["A"] }) });
    expect(await fetchArtistMeta("http://b", ["A"])).toEqual({ kind: "ok", data: { meta: { A: null }, pending: ["A"] } });
  });
  it("404 is unsupported, other failures are errors, and it never throws", async () => {
    stub({ ok: false, status: 404 });
    expect((await fetchArtistMeta("http://b", ["A"])).kind).toBe("unsupported");
    stub({ ok: false, status: 400 });
    expect((await fetchArtistMeta("http://b", ["A"])).kind).toBe("error");
    stub(new TypeError("network"));
    expect((await fetchArtistMeta("http://b", ["A"])).kind).toBe("error");
    stub({ ok: true, status: 200, json: async () => ({ nope: 1 }) });
    expect((await fetchArtistMeta("http://b", ["A"])).kind).toBe("error");
  });
});
