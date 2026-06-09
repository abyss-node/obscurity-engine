import type { TrackItem } from "../app/page";

const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? "";
const SCOPES = "playlist-modify-private playlist-modify-public";

function randomString(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => chars[b % chars.length])
    .join("");
}

async function codeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function isConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

export async function initiateSpotifyAuth(tracks: TrackItem[], username: string, period: string): Promise<void> {
  const verifier = randomString(64);
  const challenge = await codeChallenge(verifier);
  const state = randomString(16);
  const redirectUri = window.location.origin;

  sessionStorage.setItem("spotify_verifier", verifier);
  sessionStorage.setItem("spotify_state", state);
  sessionStorage.setItem("spotify_tracks", JSON.stringify(tracks));
  sessionStorage.setItem("spotify_username", username);
  sessionStorage.setItem("spotify_period", period);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export async function exchangeCode(code: string, state: string): Promise<string | null> {
  const storedState = sessionStorage.getItem("spotify_state");
  const verifier = sessionStorage.getItem("spotify_verifier");
  if (state !== storedState || !verifier) return null;

  const redirectUri = window.location.origin;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token ?? null;
}

export async function createPlaylist(
  token: string,
  tracks: TrackItem[],
  username: string,
  period: string
): Promise<string | null> {
  const meRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) return null;
  const me = await meRes.json();

  const playlistRes = await fetch(`https://api.spotify.com/v1/users/${me.id}/playlists`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Obscurity Engine — ${username} (${period})`,
      description: "Deep cuts surfaced by Obscurity Engine",
      public: false,
    }),
  });
  if (!playlistRes.ok) return null;
  const playlist = await playlistRes.json();

  // Search tracks in parallel batches to avoid rate limiting
  const BATCH = 5;
  const candidates = tracks.slice(0, 50);
  const uris: string[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (track) => {
      const q = encodeURIComponent(`track:${track.name} artist:${track.artist}`);
      try {
        const res = await fetch(
          `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.tracks?.items?.[0]?.uri ?? null;
      } catch {
        return null;
      }
    }));
    uris.push(...results.filter((u): u is string => u !== null));
  }

  if (uris.length === 0) return null;

  await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris }),
  });

  return playlist.external_urls?.spotify ?? null;
}

export function getStoredTracks(): TrackItem[] | null {
  const raw = sessionStorage.getItem("spotify_tracks");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function getStoredMeta(): { username: string; period: string } | null {
  const username = sessionStorage.getItem("spotify_username");
  const period = sessionStorage.getItem("spotify_period");
  if (!username || !period) return null;
  return { username, period };
}

export function clearSpotifySession(): void {
  ["spotify_verifier", "spotify_state", "spotify_tracks", "spotify_username", "spotify_period"]
    .forEach((k) => sessionStorage.removeItem(k));
}
