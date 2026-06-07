"use client";

import { useState, useRef } from "react";

interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

export default function Tooltip({ text, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    timerRef.current = setTimeout(() => setVisible(true), 300);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  };

  return (
    <span
      className="relative inline-block cursor-help"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {visible && (
        <span
          className="absolute bottom-full left-0 mb-2 w-56 px-3 py-2 font-mono text-[10px] leading-relaxed tracking-wide border z-50 pointer-events-none"
          style={{
            background: "var(--surface2)",
            borderColor: "var(--border)",
            color: "var(--muted)",
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
