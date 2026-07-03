"use client";

import { useEffect, useState } from "react";
import * as Spotify from "./spotify";
import { getSession, type Session } from "./session";
import { PERIOD_LABELS, APPETITE_STOPS, type DiscoveryMode, type TrackItem } from "./types";

export type SpotifyStatus = "idle" | "loading" | "success" | "error";

interface UseUrlModesSetters {
  setUsername: (v: string | null) => void;
  setInputLocal: (v: string) => void;
  setMode: (v: DiscoveryMode) => void;
  setTracks: (v: TrackItem[]) => void;
  setPeriod: (v: string) => void;
  setAppetite: (v: string) => void;
  setApiKey: (v: string) => void;
  setApiKeyInput: (v: string) => void;
}

/**
 * Owns session/isSharedView/spotifyStatus/playlistUrl and the single
 * mount-only bootstrap effect, moved VERBATIM out of app/page.tsx (only the
 * direct `set*` calls were rewritten to go through the `setters` param so
 * this hook can still reach state owned by other hooks/the coordinator).
 *
 * CAREFUL, per the original comments: this effect handles three
 * mutually-exclusive-in-practice branches in one exact precedence order —
 * (1) always read the last.fm session, independent of the other two;
 * (2) Spotify OAuth ?code&state callback — early `return`s, so branch (3)
 * never runs on that pass;
 * (3) else, ?u= shared-view vs. localStorage-restored prefs (also mutually
 * exclusive with each other, via if/else).
 * Do not split this into multiple effects or reorder the branches — that IS
 * a behavior change (see the refactor notes in the top-level handoff doc).
 */
export function useUrlModes(setters: UseUrlModesSetters) {
  const [isSharedView, setIsSharedView] = useState(false);
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyStatus>("idle");
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [session, setSessionState] = useState<Session | null>(null);

  useEffect(() => {
    // Last.fm session, if one was minted by a previous /auth/lastfm exchange.
    // Independent of the shared-view (?u=) branch below — a visitor can be
    // both viewing someone's shared results and logged in as themselves.
    setSessionState(getSession());

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    // Handle Spotify OAuth callback
    if (code && state) {
      window.history.replaceState({}, "", window.location.pathname);
      const storedTracks = Spotify.getStoredTracks();
      const meta = Spotify.getStoredMeta();
      if (storedTracks && meta) {
        setters.setUsername(meta.username);
        setters.setInputLocal(meta.username);
        setters.setMode("tracks");
        setters.setTracks(storedTracks);
        setSpotifyStatus("loading");
        (async () => {
          try {
            const token = await Spotify.exchangeCode(code, state);
            if (!token) { setSpotifyStatus("error"); return; }
            const url = await Spotify.createPlaylist(token, storedTracks, meta.username, meta.period);
            Spotify.clearSpotifySession();
            if (url) { setPlaylistUrl(url); setSpotifyStatus("success"); }
            else setSpotifyStatus("error");
          } catch {
            setSpotifyStatus("error");
          }
        })();
      }
      return;
    }

    const urlUser = params.get("u");
    const urlPeriod = params.get("p");
    const urlMode = params.get("m");
    if (urlUser) {
      setters.setUsername(urlUser);
      setters.setInputLocal(urlUser);
      setIsSharedView(true);
      if (urlPeriod && PERIOD_LABELS[urlPeriod]) setters.setPeriod(urlPeriod);
      const urlAppetite = params.get("a");
      if (urlAppetite && APPETITE_STOPS.some((s) => s.val === urlAppetite)) setters.setAppetite(urlAppetite);
      if (urlMode === "tracks" || urlMode === "artists") setters.setMode(urlMode as DiscoveryMode);
    } else {
      const saved = localStorage.getItem("obscurity_username");
      if (saved) setters.setInputLocal(saved); // pre-fill input but don't auto-fetch; user submits
      const savedPeriod = localStorage.getItem("obscurity_period");
      if (savedPeriod && PERIOD_LABELS[savedPeriod]) setters.setPeriod(savedPeriod);
      const savedAppetite = localStorage.getItem("obscurity_appetite");
      if (savedAppetite && APPETITE_STOPS.some((s) => s.val === savedAppetite)) setters.setAppetite(savedAppetite);
      const savedKey = localStorage.getItem("obscurity_api_key");
      if (savedKey) { setters.setApiKey(savedKey); setters.setApiKeyInput(savedKey); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    session,
    setSessionState,
    isSharedView,
    setIsSharedView,
    spotifyStatus,
    setSpotifyStatus,
    playlistUrl,
    setPlaylistUrl,
  };
}
