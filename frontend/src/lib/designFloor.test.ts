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
  const textTokens = ["text", "muted", "dim", "accent", "discovery"];
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("font size floor", () => {
  const files = sourceFiles(SRC);

  it("scans source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it(`has no text-[Npx] class below ${MIN_FONT_PX}px`, () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
          if (parseFloat(m[1]) < MIN_FONT_PX) hits.push(`${relative(SRC, f)}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it(`has no fontSize below ${MIN_FONT_PX}px (numeric or string)`, () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/fontSize\s*[:=]\s*\{?\s*["'`]?(\d+(?:\.\d+)?)(px)?["'`]?/g)) {
          if (parseFloat(m[1]) < MIN_FONT_PX) hits.push(`${relative(SRC, f)}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
