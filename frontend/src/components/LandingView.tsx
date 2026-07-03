"use client";

import { motion, AnimatePresence } from "framer-motion";
import OnboardingGuide from "./OnboardingGuide";
import type { Session } from "../lib/session";

interface LandingViewProps {
  inputLocal: string;
  setInputLocal: (v: string) => void;
  /** Called only when inputLocal.trim() is non-empty — the trim-check gate
   *  itself stays here (same as the original inline form handler) so this
   *  component owns the exact same guard before firing the callback. */
  onSubmitUsername: () => void;
  session: Session | null;
  onLogout: () => void;
  isLoginConfigured: boolean;
  onConnectLastfm: () => void;
  showSetup: boolean;
  setShowSetup: (v: boolean | ((s: boolean) => boolean)) => void;
  showApiKey: boolean;
  setShowApiKey: (v: boolean | ((s: boolean) => boolean)) => void;
  apiKey: string;
  apiKeyInput: string;
  setApiKeyInput: (v: string) => void;
  shareKey: boolean;
  setShareKey: (v: boolean | ((s: boolean) => boolean)) => void;
  onSaveApiKey: (key: string, share?: boolean) => void;
}

/**
 * The landing (pre-username) view, moved verbatim out of app/page.tsx's
 * `!username` branch of the AnimatePresence. Home stays the thin
 * coordinator: it owns all the state/handlers and threads them through as
 * props, unchanged in substance.
 */
export default function LandingView({
  inputLocal,
  setInputLocal,
  onSubmitUsername,
  session,
  onLogout,
  isLoginConfigured,
  onConnectLastfm,
  showSetup,
  setShowSetup,
  showApiKey,
  setShowApiKey,
  apiKey,
  apiKeyInput,
  setApiKeyInput,
  shareKey,
  setShareKey,
  onSaveApiKey,
}: LandingViewProps) {
  return (
    <motion.div
      key="landing"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.35 }}
      className="min-h-screen flex items-start justify-center px-6 py-[15vh]"
    >
      <div className="w-full max-w-md flex flex-col items-center gap-8">
        {/* Headline */}
        <div className="flex flex-col items-center gap-3 text-center">
          <h1
            className="font-serif text-4xl md:text-5xl font-bold italic leading-tight"
            style={{ color: "var(--text)" }}
          >
            Find your new<br />favorite artist.
          </h1>
          <p
            className="font-body text-sm font-light max-w-xs leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            Connects to your Last.fm history. Surfaces artists and tracks
            that match your taste but haven&apos;t broken through yet.
          </p>
        </div>

        {/* Input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (inputLocal.trim()) {
              onSubmitUsername();
            }
          }}
          className="w-full flex flex-col items-center gap-6"
        >
          <input
            autoFocus
            type="text"
            value={inputLocal}
            onChange={(e) => setInputLocal(e.target.value)}
            placeholder="last.fm username"
            className="obs-input w-full bg-transparent border-b-2 py-3 text-2xl font-mono outline-none text-center transition-colors duration-200"
            style={{
              borderColor: "var(--border)",
              color: "var(--text)",
              caretColor: "var(--accent)",
            }}
          />
          <AnimatePresence>
            {inputLocal.trim() && (
              <motion.button
                type="submit"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="font-mono text-[11px] tracking-widest transition-opacity duration-200 hover:opacity-60"
                style={{ color: "var(--muted)" }}
              >
                analyse →
              </motion.button>
            )}
          </AnimatePresence>
        </form>

        {/* Identity primitive entry point (Surface spec): quiet mono
            text near the input, hidden entirely (not disabled) unless
            NEXT_PUBLIC_LASTFM_API_KEY is configured. Once a session
            exists this becomes a "connected as" line instead. */}
        {session ? (
          <p className="font-mono text-[11px] tracking-wide" style={{ color: "var(--muted)" }}>
            connected as {session.username} ·{" "}
            <button
              type="button"
              onClick={onLogout}
              className="transition-opacity duration-150 hover:opacity-60"
              style={{ color: "var(--dim)" }}
            >
              log out
            </button>
          </p>
        ) : (
          isLoginConfigured && (
            <button
              type="button"
              onClick={onConnectLastfm}
              className="font-mono text-[11px] tracking-wide transition-opacity duration-150 hover:opacity-60"
              style={{ color: "var(--muted)" }}
            >
              connect last.fm
            </button>
          )
        )}

        {/* Onboarding links */}
        <div className="w-full flex flex-col items-center gap-5">
          <div className="flex items-center gap-4">
            <a
              href="https://www.last.fm/join"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
              style={{ color: "var(--accent)" }}
            >
              new to last.fm? create account →
            </a>
            <span className="font-mono text-[10px]" style={{ color: "var(--border)" }}>|</span>
            <button
              onClick={() => { setShowSetup((s) => !s); setShowApiKey(false); }}
              className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
              style={{ color: "var(--dim)" }}
            >
              connect your music {showSetup ? "▲" : "▼"}
            </button>
            <span className="font-mono text-[10px]" style={{ color: "var(--border)" }}>|</span>
            <button
              onClick={() => { setShowApiKey((s) => !s); setShowSetup(false); }}
              className="font-mono text-[10px] tracking-widest transition-opacity duration-150 hover:opacity-60"
              style={{ color: apiKey ? "var(--accent)" : "var(--dim)" }}
            >
              {apiKey ? "api key active ▼" : `api key ${showApiKey ? "▲" : "▼"}`}
            </button>
          </div>

          <AnimatePresence>
            {showSetup && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
                className="w-full"
              >
                <OnboardingGuide />
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showApiKey && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.25 }}
                className="w-full flex flex-col gap-3"
              >
                <div className="border p-4 flex flex-col gap-3" style={{ borderColor: "var(--border)" }}>
                  <p className="font-mono text-[10px] tracking-wider leading-relaxed" style={{ color: "var(--muted)" }}>
                    your own key avoids shared rate limits — saved to this browser permanently
                  </p>
                  <ol className="flex flex-col gap-1.5">
                    {[
                      <>go to <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener noreferrer" className="transition-opacity hover:opacity-60" style={{ color: "var(--accent)" }}>last.fm/api/account/create</a></>,
                      <>application name: anything (e.g. <span style={{ color: "var(--muted)" }}>my music tool</span>)</>,
                      <>description: anything (e.g. <span style={{ color: "var(--muted)" }}>personal use</span>)</>,
                      <>callback url: <span style={{ color: "var(--muted)" }}>leave blank</span></>,
                      <>submit → copy the 32-character api key</>,
                    ].map((step, i) => (
                      <li key={i} className="flex gap-2 font-mono text-[10px] tracking-wider leading-relaxed" style={{ color: "var(--dim)" }}>
                        <span style={{ color: "var(--border)" }}>{i + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="flex-1 bg-transparent border-b py-1 font-mono text-[11px] outline-none transition-colors duration-200"
                      style={{ borderColor: "var(--border)", color: "var(--text)", caretColor: "var(--accent)" }}
                    />
                    <button
                      onClick={() => onSaveApiKey(apiKeyInput.trim(), shareKey)}
                      className="font-mono text-[10px] tracking-widest transition-opacity hover:opacity-60 shrink-0"
                      style={{ color: "var(--muted)" }}
                    >
                      {apiKeyInput.trim() ? "save" : "clear"}
                    </button>
                  </div>
                  {/* Opt-in: contribute the key to the shared rotation pool. */}
                  <button
                    type="button"
                    onClick={() => setShareKey((s) => !s)}
                    className="flex items-start gap-2 text-left transition-opacity hover:opacity-80"
                  >
                    <span
                      className="mt-[1px] shrink-0 flex items-center justify-center font-mono text-[9px]"
                      style={{
                        width: 14, height: 14, border: "1px solid var(--accent2)",
                        color: "var(--accent)",
                        background: shareKey ? "var(--accent)" : "transparent",
                      }}
                      aria-hidden
                    >
                      {shareKey ? "✓" : ""}
                    </span>
                    <span className="font-mono text-[9px] leading-relaxed tracking-wider" style={{ color: "var(--dim)" }}>
                      also share to the pool to speed up discovery for everyone (read-only app key, no account access)
                    </span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
