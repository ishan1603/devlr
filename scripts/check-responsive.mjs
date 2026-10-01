import { spawnSync } from "node:child_process";

/**
 * Runs the screenshot check over every screen at phone, tablet and desktop
 * widths, and fails if anything overflows.
 *
 *   DEVLR_DEMO=1 npm run build && DEVLR_DEMO=1 npm run start -- -p 3210
 *   node scripts/check-responsive.mjs http://localhost:3210
 *
 * The signed-in screens are checked through /demo, which renders the same
 * components with mock data, so this needs no database and no account.
 */

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

const PAGES = [
  ["landing", "/"],
  ["signin", "/signin"],
  ["demo-index", "/demo"],
  ["onboarding", "/demo/onboarding"],
  ["home", "/demo/app"],
  ["topics", "/demo/app/topics"],
  ["schedule", "/demo/app/schedule"],
  ["issues", "/demo/app/issues"],
  ["settings", "/demo/app/settings"],
  ["email", "/demo/email"],
];

const VIEWPORTS = [
  ["phone", 360, 780, 2],
  ["phone-l", 414, 896, 2],
  ["tablet", 820, 1180, 1],
  ["desktop", 1440, 900, 1],
];

let failures = 0;
for (const [name, path] of PAGES) {
  for (const [label, width, height, scale] of VIEWPORTS) {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/screenshot.mjs",
        `${base}${path}`,
        `${name}-${label}`,
        "--width", String(width),
        "--height", String(height),
        "--scale", String(scale),
      ],
      { encoding: "utf8" }
    );
    const output = (result.stdout + result.stderr).trim();
    if (result.status !== 0) {
      failures++;
      console.log(output);
    } else {
      console.log(`ok    ${name.padEnd(12)} ${label.padEnd(8)} ${width}px`);
    }
  }
}

console.log(failures === 0 ? "\nEvery screen fits every viewport." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
