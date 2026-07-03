import { authHeader } from "./session";

/**
 * Shape returned by GET /api/me/saved. The pinned contract only fixes the
 * endpoint + auth ("saved artists with rec metadata"); the exact field list
 * isn't pinned, so this is a soft assumption the Saved view degrades around —
 * unknown/missing fields are simply not rendered rather than throwing.
 */
export type SavedArtist = {
  rec_id: string;
  artist_name: string;
  saved_at?: string;
  top_tags?: string[];
  spotify_url?: string;
  bandcamp_url?: string;
};

function apiUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
}

/** Throws on any non-2xx or network failure — callers render the message via ErrorState. */
export async function fetchSaved(): Promise<SavedArtist[]> {
  const res = await fetch(`${apiUrl()}/api/me/saved`, { headers: { ...authHeader() } });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = String(body.error);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  const data: unknown = await res.json();
  if (Array.isArray(data)) return data as SavedArtist[];
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).saved)) {
    return (data as Record<string, unknown>).saved as SavedArtist[];
  }
  return [];
}
