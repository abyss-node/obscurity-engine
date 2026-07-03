"use client";

import { useEffect, useRef } from "react";
import { Artist } from "../app/page";
import { motion, AnimatePresence } from "framer-motion";
import { firstGenreTag, isGeoTag, formatGeoTag, GEO_CANONICAL } from "../lib/geoTags";
import { normConviction, normStickiness, formatListeners } from "../lib/scoring";
import { canFireRecEvent, canPersistActions } from "../lib/capability";
import { postEvent } from "../lib/events";
import type { Session } from "../lib/session";

interface ArtistCardProps {
  artist: Artist;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
  isFocused?: boolean;
  // Persistence capability + session (Phase 1-B). All optional so existing
  // callers (e.g. the read-only /r/[id] view) keep working with save/dismiss
  // fully hidden.
  session?: Session | null;
  persistence?: boolean;
  runId?: string | null;
  saved?: boolean;
  onSave?: () => void;
  onUnsave?: () => void;
  onDismiss?: () => void;
}

/** A resolved listen/find destination. Last.fm + Spotify always render; the
 *  others only when the backend resolver confirmed they exist. */
type LinkDef = {
  label: string;
  href: string;
  share?: boolean;
  target?: "lastfm" | "spotify" | "bandcamp" | "thisis";
};

const StatBlock = ({ value, caption }: { value: string; caption: string }) => (
  <div className="flex flex-col gap-1.5">
    <span className="font-mono text-[19px] leading-none" style={{ color: "var(--text)" }}>{value}</span>
    <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
      {caption}
    </span>
  </div>
);

const ledgerCols =
  "grid-cols-[20px_minmax(0,1fr)_40px_46px_16px] min-[720px]:grid-cols-[26px_minmax(0,1fr)_148px_104px_70px_74px_22px]";

export default function ArtistCard({
  artist,
  rank,
  expanded,
  onToggle,
  isFocused,
  session = null,
  persistence = false,
  runId = null,
  saved = false,
  onSave,
  onUnsave,
  onDismiss,
}: ArtistCardProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused) {
      setTimeout(() => rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }, [isFocused]);

  const primaryTag = firstGenreTag(artist.top_tags);
  const country = (() => {
    for (const t of artist.top_tags) {
      if (!isGeoTag(t)) continue;
      return GEO_CANONICAL.get(t.toLowerCase()) ?? t.toLowerCase();
    }
    return "";
  })();
  const extraGenres = artist.top_tags
    .filter((t) => !isGeoTag(t) && t.length <= 25 && t.toLowerCase() !== (primaryTag ?? "").toLowerCase())
    .slice(0, 6);

  const conviction = normConviction(artist);
  const stickiness = normStickiness(artist);
  const genreFit = Math.round((artist.taste_alignment ?? 0) * 100);
  const allSeeds = (artist.source_seeds ?? []).map((s) => s.name);

  const lastfmUrl = `https://www.last.fm/music/${encodeURIComponent(artist.name)}`;
  // Prefer a backend-resolved exact URL; otherwise fall back to a search that
  // always lands somewhere useful (never a dead link).
  const spotifyUrl =
    artist.spotify_url ?? `https://open.spotify.com/search/${encodeURIComponent(artist.name)}`;
  const bandcampUrl =
    artist.bandcamp_url ?? `https://bandcamp.com/search?q=${encodeURIComponent(artist.name)}&item_type=b`;
  // Share the artist's Spotify page on WhatsApp. wa.me opens the app (mobile) or
  // WhatsApp Web (desktop) with the message pre-filled; the user picks the chat.
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${artist.name} on Spotify: ${spotifyUrl}`)}`;

  // Last.fm + Spotify + Bandcamp always; "This Is" only when the resolver confirms it.
  const links: LinkDef[] = [
    { label: "Last.fm", href: lastfmUrl, target: "lastfm" },
    { label: "Spotify", href: spotifyUrl, target: "spotify" },
    { label: "Bandcamp", href: bandcampUrl, target: "bandcamp" },
    ...(artist.this_is_url ? [{ label: '"This Is" playlist', href: artist.this_is_url, target: "thisis" as const }] : []),
    { label: "WhatsApp", href: whatsappUrl, share: true },
  ];

  // click_listen/share fire whenever a rec_id exists — no auth needed, never
  // blocks the link's default navigation.
  const handleLinkClick = (l: LinkDef) => {
    if (!canFireRecEvent(artist.rec_id)) return;
    void postEvent({
      rec_id: artist.rec_id,
      run_id: runId ?? undefined,
      type: l.share ? "share" : "click_listen",
      target: l.share ? undefined : l.target,
    });
  };

  const canPersist = canPersistActions(session, persistence, artist.rec_id);

  return (
    <div
      ref={rowRef}
      className="group border-b"
      style={{ borderColor: isFocused ? "var(--accent)" : "var(--border)" }}
    >
      {/* Row */}
      <button
        type="button"
        onClick={onToggle}
        className={`grid w-full items-center gap-2.5 min-[720px]:gap-4 px-3 py-3.5 text-left transition-colors duration-150 ${ledgerCols}`}
        style={{ background: expanded ? "var(--surface)" : "transparent" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = expanded ? "var(--surface)" : "transparent")}
      >
        {/* rank */}
        <span className="font-mono text-[10px] tracking-wider" style={{ color: "var(--dim)" }}>
          {String(rank).padStart(2, "0")}
        </span>

        {/* artist name (the full "via" seed list lives in the expanded panel) */}
        <span className="flex items-center gap-2 min-w-0">
          {artist.cross_validated && (
            <span className="shrink-0 text-[12px] leading-none" style={{ color: "var(--accent)" }} aria-label="dual-signal">
              ✦
            </span>
          )}
          {saved && (
            <span className="shrink-0 text-[10px] leading-none" style={{ color: "var(--text)" }} aria-label="saved">
              ●
            </span>
          )}
          <span className="font-serif font-semibold text-[15px] min-[720px]:text-[18px] leading-tight break-words min-[720px]:truncate" style={{ color: "var(--text)" }}>
            {artist.name}
          </span>
        </span>

        {/* genre (desktop) */}
        <span
          className="hidden min-[720px]:block font-mono text-[9px] tracking-widest uppercase truncate"
          style={{ color: "var(--muted)" }}
        >
          {primaryTag ?? ""}
        </span>

        {/* country (desktop) */}
        <span
          className="hidden min-[720px]:block font-mono text-[9px] tracking-widest uppercase truncate"
          style={{ color: "var(--dim)" }}
        >
          {country ? formatGeoTag(country) : ""}
        </span>

        {/* conviction */}
        <span className="font-mono text-[13px] text-center tabular-nums" style={{ color: "var(--text)" }}>
          {conviction}
        </span>

        {/* listeners */}
        <span className="font-mono text-[11px] text-center tabular-nums" style={{ color: "var(--dim)" }}>
          {formatListeners(artist.total_listeners)}
        </span>

        {/* expand toggle */}
        <span className="font-mono text-[14px] text-right leading-none" style={{ color: "var(--dim)" }}>
          {expanded ? "–" : "+"}
        </span>
      </button>

      {/* Expanded panel */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
            style={{ background: "var(--surface)" }}
          >
            <div className="grid grid-cols-1 min-[720px]:grid-cols-[1fr_264px] gap-12 px-3 pb-7 pt-1 min-[720px]:pl-[46px]">
              {/* Left: metrics + genres */}
              <div className="flex flex-col gap-7">
                <div className="grid grid-cols-3 gap-6">
                  <StatBlock value={`${conviction}`} caption="how strongly your seeds point here" />
                  <StatBlock value={genreFit > 0 ? `${genreFit}` : "—"} caption="overlap with your taste profile" />
                  <StatBlock value={`${stickiness}`} caption="likelihood you'll keep them" />
                </div>
                {allSeeds.length > 0 && (
                  <div className="flex flex-col gap-2.5">
                    <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                      recommended via
                    </span>
                    <p className="font-mono text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                      {allSeeds.join("  ·  ")}
                    </p>
                  </div>
                )}
                {extraGenres.length > 0 && (
                  <div className="flex flex-col gap-2.5">
                    <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>genres</span>
                    <div className="flex flex-wrap gap-2">
                      {extraGenres.map((tag) => (
                        <span
                          key={tag}
                          className="font-mono text-[9px] tracking-widest uppercase px-2.5 py-1 border"
                          style={{ color: "var(--muted)", borderColor: "var(--border)" }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Save / dismiss — mono 10px text actions, hover-reveal on
                    desktop (the whole card is the hover target). Hidden
                    entirely (not disabled) unless persistence + session +
                    rec_id all check out — a hidden button never silently
                    no-ops. */}
                {canPersist && (
                  <div
                    className="flex items-center gap-5 min-[720px]:opacity-0 min-[720px]:group-hover:opacity-100 transition-opacity duration-150"
                    data-testid="persist-actions"
                  >
                    {saved ? (
                      <button
                        type="button"
                        onClick={onUnsave}
                        className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                        style={{ color: "var(--text)" }}
                      >
                        <span aria-hidden>●</span> saved
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onSave}
                        className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                        style={{ color: "var(--muted)" }}
                      >
                        save
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onDismiss}
                      className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                      style={{ color: "var(--muted)" }}
                    >
                      dismiss
                    </button>
                  </div>
                )}
              </div>

              {/* Right: listen / find */}
              <div className="flex flex-col gap-3">
                <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>listen / find</span>
                <div className="flex flex-col gap-2">
                  {links.map((l) => (
                    <a
                      key={l.label}
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => handleLinkClick(l)}
                      className="flex items-center justify-between px-3 py-2.5 border font-mono text-[10px] tracking-wider transition-colors duration-150"
                      style={{ color: "var(--accent)", borderColor: "var(--border)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = "var(--accent2)";
                        e.currentTarget.style.color = "var(--accent-bright)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = "var(--border)";
                        e.currentTarget.style.color = "var(--accent)";
                      }}
                    >
                      <span>{l.label}</span>
                      <span>{l.share ? "↪" : "↗"}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
