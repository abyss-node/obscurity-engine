"use client";

import { useMemo } from "react";
import { Artist } from "../app/page";
import { normConviction, normStickiness, formatListeners } from "../lib/scoring";
import { canFireRecEvent } from "../lib/capability";
import { postEvent } from "../lib/events";
import { firstGenreTag, formatGeoTag, countryFromTags } from "../lib/geoTags";

interface HeroPicksProps {
  artists: Artist[];
  depthScore: number;
  runId?: string | null;
}

type HeroLink = {
  label: string;
  href: string;
  target: "lastfm" | "spotify" | "bandcamp";
};

function linksFor(artist: Artist): HeroLink[] {
  const spotifyUrl =
    artist.spotify_url ?? `https://open.spotify.com/search/${encodeURIComponent(artist.name)}`;
  const bandcampUrl =
    artist.bandcamp_url ?? `https://bandcamp.com/search?q=${encodeURIComponent(artist.name)}&item_type=b`;
  return [
    { label: "Last.fm", href: `https://www.last.fm/music/${encodeURIComponent(artist.name)}`, target: "lastfm" },
    { label: "Spotify", href: spotifyUrl, target: "spotify" },
    { label: "Bandcamp", href: bandcampUrl, target: "bandcamp" },
  ];
}

/**
 * Top-3 "Top Picks" hero cards — the strongest recommendations from this run,
 * selected by composite_score, above the Suggestions/Analytics tabs.
 *
 * Renders nothing (not an empty placeholder) when there are fewer than 3
 * artists to show — the caller additionally gates this to artists mode only.
 */
export default function HeroPicks({ artists, depthScore, runId = null }: HeroPicksProps) {
  const top3 = useMemo(
    () => [...artists].sort((a, b) => b.composite_score - a.composite_score).slice(0, 3),
    [artists]
  );

  if (top3.length < 3) return null;

  const handleLinkClick = (artist: Artist, l: HeroLink) => {
    if (!canFireRecEvent(artist.rec_id)) return;
    void postEvent({
      rec_id: artist.rec_id,
      run_id: runId ?? undefined,
      type: "click_listen",
      target: l.target,
    });
  };

  return (
    <div className="pt-6 min-[720px]:pt-12" data-testid="hero-picks">
      <div className="flex items-baseline justify-between flex-wrap gap-2.5">
        <div className="flex items-baseline gap-3.5">
          <span className="font-mono text-[10px] tracking-[0.24em] uppercase" style={{ color: "var(--dim)" }}>
            top picks
          </span>
          <span className="font-mono text-[9px]" style={{ color: "var(--dim)", opacity: 0.7 }}>
            strongest signal from this run
          </span>
        </div>
        {depthScore > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] tracking-[0.24em] uppercase" style={{ color: "var(--dim)" }}>
              obscurity index
            </span>
            <span className="font-serif text-2xl font-bold italic leading-none" style={{ color: "var(--accent)" }}>
              {depthScore.toFixed(0)}
            </span>
            <span className="font-mono text-[11px]" style={{ color: "var(--dim)" }}>
              / 100
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 min-[900px]:grid-cols-3 gap-3 mt-4">
        {top3.map((artist, idx) => {
          const conviction = normConviction(artist);
          const stickiness = normStickiness(artist);
          const primaryTag = firstGenreTag(artist.top_tags);
          const countryKey = countryFromTags(artist.top_tags);
          const country = countryKey ? formatGeoTag(countryKey) : "";
          const meta = [primaryTag, country].filter(Boolean).join(" · ");
          const links = linksFor(artist);
          const seeds = (artist.source_seeds ?? []).slice(0, 2).map((s) => s.name);

          return (
            <div
              key={artist.name}
              className="flex flex-col p-[22px] pb-[18px]"
              style={{
                border: "1px solid var(--border)",
                borderTop: idx === 0 ? "2px solid var(--accent)" : "2px solid var(--border)",
                background: "var(--surface)",
              }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
                  {String(idx + 1).padStart(2, "0")}
                </span>
                {artist.cross_validated && (
                  <span className="font-mono text-[9px] tracking-[0.16em]" style={{ color: "var(--accent)" }}>
                    ✦ dual-signal
                  </span>
                )}
              </div>

              <div
                className="font-serif font-semibold text-2xl leading-[1.15] mt-3"
                style={{ color: "var(--text)", textWrap: "balance" as React.CSSProperties["textWrap"] }}
              >
                {artist.name}
              </div>

              <div className="font-mono text-[9px] tracking-[0.14em] uppercase mt-2.5" style={{ color: "var(--muted)" }}>
                {meta}
              </div>

              <div className="flex items-end gap-6 mt-5">
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[22px] font-medium leading-none" style={{ color: "var(--text)" }}>
                    {conviction}
                  </span>
                  <span className="font-mono text-[8px] tracking-[0.16em] uppercase" style={{ color: "var(--dim)" }}>
                    conviction
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[22px] font-medium leading-none" style={{ color: "var(--muted)" }}>
                    {stickiness}
                  </span>
                  <span className="font-mono text-[8px] tracking-[0.16em] uppercase" style={{ color: "var(--dim)" }}>
                    stickiness
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[22px] font-medium leading-none" style={{ color: "var(--muted)" }}>
                    {formatListeners(artist.total_listeners)}
                  </span>
                  <span className="font-mono text-[8px] tracking-[0.16em] uppercase" style={{ color: "var(--dim)" }}>
                    listeners
                  </span>
                </div>
              </div>

              {seeds.length > 0 && (
                <div className="font-mono text-[10px] mt-4 leading-relaxed" style={{ color: "var(--dim)" }}>
                  via <span style={{ color: "var(--muted)" }}>{seeds.join(" · ")}</span>
                </div>
              )}

              <div className="flex gap-1.5 mt-3.5 flex-wrap">
                {links.map((l) => (
                  <a
                    key={l.label}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => handleLinkClick(artist, l)}
                    className="font-mono text-[9px] tracking-wider px-2.5 py-1.5 transition-colors duration-150"
                    style={{ border: "1px solid var(--border)", color: "var(--accent)" }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--accent2)";
                      e.currentTarget.style.color = "var(--accent-bright)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border)";
                      e.currentTarget.style.color = "var(--accent)";
                    }}
                  >
                    {l.label} ↗
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
