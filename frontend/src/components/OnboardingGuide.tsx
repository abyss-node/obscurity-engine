"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Platform {
  id: string;
  label: string;
  os: string;
  steps: { text: string; link?: { label: string; href: string } }[];
}

const PLATFORMS: Platform[] = [
  {
    id: "spotify",
    label: "Spotify",
    os: "All platforms",
    steps: [
      { text: "Open Spotify → Settings → Social" },
      { text: "Connect to Last.fm and log in" },
      { text: "Every play on any Spotify device scrobbles automatically" },
    ],
  },
  {
    id: "android",
    label: "YouTube Music / Android",
    os: "Android",
    steps: [
      {
        text: "Install PanoScrobbler from the Play Store",
        link: {
          label: "PanoScrobbler →",
          href: "https://play.google.com/store/apps/details?id=com.muesil0.panoscrobbler",
        },
      },
      { text: "Open PanoScrobbler → connect your Last.fm account" },
      { text: "Grant notification access — it reads what any app is playing" },
      { text: "Works with YouTube Music, Tidal, Deezer, and 40+ other apps" },
    ],
  },
  {
    id: "chrome",
    label: "YouTube Music / Desktop",
    os: "Chrome · Firefox · Edge",
    steps: [
      {
        text: "Install Web Scrobbler from the Chrome Web Store",
        link: {
          label: "Web Scrobbler →",
          href: "https://chrome.google.com/webstore/detail/web-scrobbler/hhinaapppaileiechjoiifaancjggfjm",
        },
      },
      { text: "Click the extension icon → connect your Last.fm account" },
      {
        text: "Scrobbles YouTube Music, Spotify Web, Tidal, Deezer, SoundCloud, and more in the browser",
      },
    ],
  },
  {
    id: "iphone",
    label: "iPhone",
    os: "iOS",
    steps: [
      {
        text: "For Spotify: connect in Spotify Settings → Social (no extra app needed)",
      },
      {
        text: "For Apple Music: install the Last.fm app",
        link: {
          label: "Last.fm on App Store →",
          href: "https://apps.apple.com/app/last-fm/id1188681944",
        },
      },
      {
        text: "For YouTube Music on iPhone: open youtube.com/music in Chrome and use Web Scrobbler",
        link: {
          label: "Web Scrobbler →",
          href: "https://chrome.google.com/webstore/detail/web-scrobbler/hhinaapppaileiechjoiifaancjggfjm",
        },
      },
    ],
  },
  {
    id: "mac",
    label: "Mac",
    os: "macOS",
    steps: [
      {
        text: "For Spotify: connect in Spotify Settings → Social",
      },
      {
        text: "For Apple Music: download the Last.fm desktop scrobbler",
        link: { label: "Last.fm Desktop →", href: "https://www.last.fm/about/download" },
      },
      {
        text: "For browser-based streaming: install Web Scrobbler in Chrome or Firefox",
        link: {
          label: "Web Scrobbler →",
          href: "https://chrome.google.com/webstore/detail/web-scrobbler/hhinaapppaileiechjoiifaancjggfjm",
        },
      },
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
