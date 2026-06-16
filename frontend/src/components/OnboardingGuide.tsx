"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Platform {
  id: string;
  label: string;
  os: string;
  steps: { text: string; link?: { label: string; href: string } }[];
}

// Platforms per the redesign spec (§7). iPhone & Mac intentionally removed for
// the alpha. Spotify connects via Last.fm's OAuth page directly — NOT the old
// "Spotify Settings → Social" path.
const PLATFORMS: Platform[] = [
  {
    id: "spotify",
    label: "Spotify",
    os: "All platforms",
    steps: [
      {
        text: "Open your Last.fm application settings",
        link: {
          label: "last.fm/settings/applications →",
          href: "https://www.last.fm/settings/applications",
        },
      },
      { text: "Under “Spotify scrobbling”, click Connect and authorize Last.fm" },
      { text: "Every play on any Spotify device now scrobbles automatically" },
      { text: "(You can also reach this from the Last.fm footer → Track My Music → Spotify)" },
    ],
  },
  {
    id: "android",
    label: "Android",
    os: "YouTube Music · Tidal · 40+ apps",
    steps: [
      {
        text: "Install Pano Scrobbler from the Play Store",
        link: {
          label: "Pano Scrobbler →",
          href: "https://play.google.com/store/apps/details?id=com.muesil0.panoscrobbler",
        },
      },
      { text: "Open Pano Scrobbler → connect your Last.fm account" },
      { text: "Grant notification access — it reads what any app is playing" },
      { text: "Works with YouTube Music, Tidal, Deezer, and most Android players" },
    ],
  },
  {
    id: "desktop",
    label: "Desktop browser",
    os: "Chrome · Firefox · Edge",
    steps: [
      {
        text: "Install the Web Scrobbler extension",
        link: {
          label: "Web Scrobbler →",
          href: "https://chrome.google.com/webstore/detail/web-scrobbler/hhinaapppaileiechjoiifaancjggfjm",
        },
      },
      { text: "Click the extension icon → connect your Last.fm account" },
      { text: "Scrobbles YouTube Music, Spotify Web, Tidal, Deezer, SoundCloud, and more" },
    ],
  },
];

export default function OnboardingGuide() {
  const [active, setActive] = useState<string | null>(null);

  return (
    <div className="w-full flex flex-col gap-1">
      {PLATFORMS.map((p) => (
        <div key={p.id} className="border" style={{ borderColor: "var(--border)" }}>
          <button
            onClick={() => setActive(active === p.id ? null : p.id)}
            className="w-full flex justify-between items-center px-4 py-3 text-left transition-opacity duration-150 hover:opacity-70"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[11px] tracking-wide" style={{ color: "var(--text)" }}>
                {p.label}
              </span>
              <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: "var(--dim)" }}>
                {p.os}
              </span>
            </div>
            <span className="font-mono text-[10px]" style={{ color: "var(--dim)" }}>
              {active === p.id ? "▲" : "▼"}
            </span>
          </button>

          <AnimatePresence>
            {active === p.id && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden"
              >
                <div
                  className="px-4 pb-4 pt-1 flex flex-col gap-2 border-t"
                  style={{ borderColor: "var(--border)" }}
                >
                  {p.steps.map((step, i) => (
                    <div key={i} className="flex gap-3 items-start">
                      <span
                        className="font-mono text-[9px] tracking-widest shrink-0 mt-0.5"
                        style={{ color: "var(--dim)" }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="flex flex-col gap-1">
                        <span className="font-body text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
                          {step.text}
                        </span>
                        {step.link && (
                          <a
                            href={step.link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
                            style={{ color: "var(--accent)" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {step.link.label}
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}
