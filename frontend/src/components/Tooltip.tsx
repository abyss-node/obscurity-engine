"use client";

import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

/**
 * Hover tooltip. The popup is rendered through a portal to <body> with
 * position:fixed, anchored to the trigger's on-screen rect. This is
 * load-bearing: the sort-tab row that uses these tooltips lives inside an
 * `overflow-x-auto` container (for mobile tab scrolling), and CSS forces the
 * cross-axis to clip too — so an in-flow `absolute` popup got sliced off at
 * the container edge. Portaling to <body> escapes that clip entirely.
 */
export default function Tooltip({ text, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const show = () => {
    timerRef.current = setTimeout(() => {
      const el = wrapRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // Anchor to the top-center of the trigger; the popup itself is shifted
        // up and centered via translate below, so this is its bottom-center.
        setCoords({ top: r.top, left: r.left + r.width / 2 });
      }
      setVisible(true);
    }, 300);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  };

  return (
    <span
      ref={wrapRef}
      className="relative inline-block cursor-help"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {visible && (
              <motion.span
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.15 }}
                className="fixed -translate-x-1/2 -translate-y-full w-52 px-3 py-2 font-mono text-[10px] leading-relaxed tracking-wide border z-[100] pointer-events-none"
                style={{
                  top: coords.top - 8,
                  left: coords.left,
                  background: "var(--surface2)",
                  borderColor: "var(--border)",
                  color: "var(--muted)",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                }}
              >
                {text}
              </motion.span>
            )}
          </AnimatePresence>,
          document.body
        )}
    </span>
  );
}
