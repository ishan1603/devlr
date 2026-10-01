import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The palette, held to WCAG AA.
 *
 * Reads the tokens straight out of app/globals.css and the email template, so
 * it checks the colours that actually ship. A palette tweak that makes the
 * small grey text unreadable fails here instead of being noticed by a user.
 */

const AA = 4.5;

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The custom properties declared inside one `selector { ... }` block. */
function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `no "${selector}" block in globals.css`);
  const block = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[match[1]] = match[2];
  return out;
}

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const light = tokens(css, ":root");
const dark = { ...light, ...tokens(css, ".dark") };

/** [foreground token, background token]: every pairing the UI actually uses for text. */
const PAIRS: [string, string][] = [
  ["text", "bg"], ["text", "surface"], ["text", "surface-sunken"],
  ["text-muted", "bg"], ["text-muted", "surface"], ["text-muted", "surface-sunken"],
  ["text-subtle", "bg"], ["text-subtle", "surface"], ["text-subtle", "surface-sunken"],
  ["accent", "bg"], ["accent", "surface"], ["accent", "accent-soft"],
  ["on-accent", "accent-fill"], ["on-accent", "accent-fill-hover"],
  ["success", "success-soft"], ["warning", "warning-soft"], ["danger", "danger-soft"],
  ["success", "surface"], ["warning", "surface"], ["danger", "surface"],
];

for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
  describe(`${name} theme contrast`, () => {
    for (const [fg, bg] of PAIRS) {
      test(`${fg} on ${bg}`, () => {
        assert.ok(theme[fg], `token --${fg} is missing`);
        assert.ok(theme[bg], `token --${bg} is missing`);
        const ratio = contrast(theme[fg], theme[bg]);
        assert.ok(ratio >= AA, `${theme[fg]} on ${theme[bg]} is ${ratio.toFixed(2)}:1, needs ${AA}:1`);
      });
    }

    test("the three text steps stay in order", () => {
      const on = (token: string) => contrast(theme[token], theme.bg);
      assert.ok(on("text") > on("text-muted") && on("text-muted") > on("text-subtle"));
    });
  });
}

describe("every theme token exists in both themes", () => {
  test("nothing is defined for dark mode only", () => {
    // A token that exists only in .dark is undefined in light mode, and the
    // element it styles silently loses its colour.
    const darkOnly = Object.keys(tokens(css, ".dark")).filter((key) => !(key in light));
    assert.deepEqual(darkOnly, []);
  });
});

describe("email contrast", () => {
  const source = readFileSync(join(process.cwd(), "lib", "email", "IssueEmail.tsx"), "utf8");

  const palette: Record<string, string> = {};
  const block = source.slice(source.indexOf("const C = {"), source.indexOf("};", source.indexOf("const C = {")));
  for (const match of block.matchAll(/(\w+):\s*"(#[0-9a-fA-F]{6})"/g)) palette[match[1]] = match[2];

  const darkRule = (className: string, property: string): string => {
    const match = source.match(new RegExp(`\\.${className}[^{]*\\{[^}]*${property}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(match, `no dark-mode ${property} for .${className}`);
    return match[1];
  };

  test("light: every text colour is readable on the card and the page", () => {
    for (const fg of ["ink", "body", "muted", "accent", "warning", "danger"]) {
      for (const bg of ["card", "page"]) {
        const ratio = contrast(palette[fg], palette[bg]);
        assert.ok(ratio >= AA, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  test("the masthead is readable in both themes", () => {
    assert.ok(contrast(palette.mastInk, palette.mastBg) >= AA);
    assert.ok(contrast(palette.mastMuted, palette.mastBg) >= AA);
    assert.ok(contrast(palette.lime, palette.mastBg) >= AA);
  });

  test("dark: every text colour is re-coloured to stay readable", () => {
    const card = darkRule("d-card", "background");
    const checks: [string, string][] = [
      ["d-ink", "color"],
      ["d-body", "color"],
      ["d-muted", "color"],
      ["d-accent", "color"],
      ["d-warning", "color"],
      ["d-danger", "color"],
    ];
    for (const [className, property] of checks) {
      const ratio = contrast(darkRule(className, property), card);
      assert.ok(ratio >= AA, `.${className} on the dark card is ${ratio.toFixed(2)}:1`);
    }
  });
});
