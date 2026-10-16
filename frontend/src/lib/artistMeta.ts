import type { ArtistMeta, ArtistMetaResponse } from "./types";
import { formatGeoTag } from "./geoTags";

export const MAX_META_NAMES = 25;
const MAX_NAME_LEN = 200;

const TYPE_LABELS: Record<string, string> = {
  group: "band",
  person: "solo",
  orchestra: "orchestra",
  choir: "choir",
};

/** MusicBrainz artist type -> short display word. Unknown types pass through lowercased. */
export function formatArtistType(type: string | null | undefined): string | null {
  const t = type?.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  return TYPE_LABELS[lower] ?? lower;
}

/** Country name for an MB country code; null when Intl cannot name it (XW/XE, malformed). */
export function countryNameFromIso(iso2: string): string | null {
  try {
    const code = iso2.trim().toUpperCase();
    const name = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

function metaCountry(meta: ArtistMeta): string | null {
  if (!meta.country_iso2) return null;
  const area = meta.area_name?.trim().replace(/^\[(.*)\]$/, "$1").trim();
  return countryNameFromIso(meta.country_iso2) ?? (area || null);
}

/**
 * Origin split for two-line display: `line1` (country, "Sweden") and `line2`
 * ("2014 · band"). With no country, line 1 carries the year/type instead. Country: MusicBrainz first, else the tag guess
 * (`tagCountryKey` from countryFromTags). Year and type only come from MB.
 * Missing parts are empty strings.
 */
// Tag-guess keys whose short display form differs from the Intl region name MB
// results use; mapped in the display path only so the column reads uniformly.
const TAG_DISPLAY: Record<string, string> = {
  usa: "United States",
  us: "United States",
  uk: "United Kingdom",
};

export function formatArtistOriginParts(
  meta: ArtistMeta | null | undefined,
  tagCountryKey: string | null | undefined
): { line1: string; line2: string } {
  const country =
    (meta ? metaCountry(meta) : null) ?? (tagCountryKey ? TAG_DISPLAY[tagCountryKey] ?? formatGeoTag(tagCountryKey) : null);
  const year = meta?.begin_year ? String(meta.begin_year) : null;
  const type = formatArtistType(meta?.artist_type);
  const detail = [year, type].filter(Boolean).join(" · ");
  // No country: the detail takes line 1 rather than leaving it blank.
  return country ? { line1: country, line2: detail } : { line1: detail, line2: "" };
}

/** "Sweden · 2014 · band", parts omitted when absent; "" when nothing is known. */
export function formatArtistOrigin(
  meta: ArtistMeta | null | undefined,
  tagCountryKey: string | null | undefined
): string {
  const { line1, line2 } = formatArtistOriginParts(meta, tagCountryKey);
  return [line1, line2].filter(Boolean).join(" · ");
}

/** Distinct, non-blank, <=200-char names, capped at 25 (the endpoint's limits). */
export function metaRequestNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n.trim() || n.length > MAX_NAME_LEN || out.includes(n)) continue;
    out.push(n);
    if (out.length === MAX_META_NAMES) break;
  }
  return out;
}

export function artistMetaUrl(apiUrl: string, names: string[]): string {
  const qs = new URLSearchParams();
  for (const n of names) qs.append("name", n);
  return `${apiUrl}/api/artist-meta?${qs.toString()}`;
}

export type MetaFetchResult =
  | { kind: "ok"; data: ArtistMetaResponse }
  | { kind: "unsupported" } // 404: older backend without the endpoint
  | { kind: "error" };

/** Never throws. Any failure is "no meta" — the card must not break. */
export async function fetchArtistMeta(
  apiUrl: string,
  names: string[],
  signal?: AbortSignal
): Promise<MetaFetchResult> {
  try {
    const res = await fetch(artistMetaUrl(apiUrl, names), { signal });
    if (res.status === 404) return { kind: "unsupported" };
    if (!res.ok) return { kind: "error" };
    const body = (await res.json()) as Partial<ArtistMetaResponse> | null;
    if (!body || typeof body.meta !== "object" || body.meta === null) return { kind: "error" };
    return {
      kind: "ok",
      data: { meta: body.meta, pending: Array.isArray(body.pending) ? body.pending : [] },
    };
  } catch {
    return { kind: "error" };
  }
}
