import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['var(--font-playfair)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'monospace'],
        body: ['var(--font-serif)', 'Georgia', 'serif'],
      },
      colors: {
        // Hover-brightened gold (handoff "gold-bright" token). Registered so the
        // token is part of the Tailwind theme; components reference the CSS var.
        'accent-bright': 'var(--accent-bright)',
      },
    },
  },
  plugins: [],
};
export default config;
