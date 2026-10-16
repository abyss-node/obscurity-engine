// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the legibility floor: text tokens reach WCAG AA (4.5:1) on every
// surface, and no rendered text is below 11px. Both regressed silently before
// because nothing enforced them.

const SRC = join(__dirname, "..");
const MIN_FONT_PX = 11;
const MIN_CONTRAST = 4.5;

function rootTokens(): Record<string, string> {
  const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const tokens: Record<string, string> = {};
  for (const m of root.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[m[1]] = m[2];
  }
  return tokens;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("text token contrast", () => {
  const tokens = rootTokens();
  const textTokens = ["text", "muted", "dim", "accent", "accent-bright", "discovery"];
  const surfaces = ["bg", "surface", "surface2"];

  it("parses the tokens it checks", () => {
    for (const name of [...textTokens, ...surfaces]) {
      expect(tokens[name], `--${name} missing from :root`).toBeDefined();
    }
  });

  for (const t of textTokens) {
    for (const s of surfaces) {
      it(`--${t} on --${s} is at least ${MIN_CONTRAST}:1`, () => {
        expect(contrast(tokens[t], tokens[s])).toBeGreaterThanOrEqual(MIN_CONTRAST);
      });
    }
  }
});

const FONT_BASE_PX = 16;

function toPx(value: string, unit: string | undefined): number {
  const n = parseFloat(value);
  return unit === "rem" || unit === "em" ? n * FONT_BASE_PX : n;
}

function sourceFiles(dir: string, exts: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p, exts);
    return exts.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

type Line = { file: string; no: number; text: string };

function lines(files: string[]): Line[] {
  return files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split(/\r?\n/)
      .map((text, i) => ({ file: relative(SRC, f), no: i + 1, text })),
  );
}

const codeLines = () => lines(sourceFiles(SRC, /\.(tsx?|css)$/));
const fmt = (l: Line, m: string) => `${l.file}:${l.no} ${m}`;

describe("font size floor", () => {
  it("scans source files", () => {
    expect(codeLines().length).toBeGreaterThan(1000);
  });

  it(`has no Tailwind text-[size] class below ${MIN_FONT_PX}px (px, rem, em, length: prefix)`, () => {
    const hits: string[] = [];
    for (const l of codeLines()) {
      for (const m of l.text.matchAll(/text-\[(?:length:)?(\d*\.?\d+)(px|rem|em)\]/g)) {
        if (toPx(m[1], m[2]) < MIN_FONT_PX) hits.push(fmt(l, m[0]));
      }
    }
    expect(hits).toEqual([]);
  });

  it(`has no inline fontSize or CSS font-size below ${MIN_FONT_PX}px`, () => {
    const hits: string[] = [];
    for (const l of codeLines()) {
      for (const m of l.text.matchAll(
        /(?:fontSize\s*[:=]\s*\{?\s*|font-size\s*:\s*)["'`]?(\d*\.?\d+)(px|rem|em)?["'`]?/g,
      )) {
        if (toPx(m[1], m[2]) < MIN_FONT_PX) hits.push(fmt(l, m[0]));
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("text colour usage", () => {
  const tokens = rootTokens();
  const surfaces = ["bg", "surface", "surface2"].map((n) => tokens[n]);
  const allowedTextTokens = new Set(["text", "muted", "dim", "accent", "accent-bright", "discovery"]);

  function hexOf(raw: string): string | null {
    const h = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
    if (!h) return null;
    const d = h[1];
    return "#" + (d.length === 3 ? [...d].map((c) => c + c).join("") : d);
  }

  function rgbOf(r: string, g: string, b: string): string {
    return "#" + [r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
  }

  it("every colour set on text meets 4.5:1 and uses a text-safe token", () => {
    const hits: string[] = [];
    for (const l of codeLines()) {
      // Token definitions are checked by the token test above.
      if (/^\s*--[\w-]+\s*:/.test(l.text)) continue;
      const decorative = /\/\*\s*decorative\s*\*\//.test(l.text);
      const tails: string[] = [];
      for (const m of l.text.matchAll(/(?<![-\w])color\s*:(.*)$/g)) tails.push(m[1].split(/,\s*[A-Za-z]+\s*:/)[0]);
      for (const m of l.text.matchAll(/(?<![-\w])text-\[((?:color:)?(?:#[0-9a-fA-F]{3,6}|var\(--[\w-]+\)))\]/g)) tails.push(m[1]);
      for (const tail of tails) {
        for (const m of tail.matchAll(/var\(--([\w-]+)\)/g)) {
          if (!allowedTextTokens.has(m[1]) && !decorative) {
            hits.push(fmt(l, `--${m[1]} used as text colour (mark /* decorative */ if it is a glyph, not text)`));
          }
        }
        const colours = [
          ...[...tail.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => hexOf(m[0])),
          ...[...tail.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)].map((m) => rgbOf(m[1], m[2], m[3])),
        ];
        for (const hex of colours) {
          if (!hex || decorative) continue;
          const worst = Math.min(...surfaces.map((s) => contrast(hex, s)));
          if (worst < MIN_CONTRAST) hits.push(fmt(l, `${hex} is ${worst.toFixed(2)}:1`));
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
