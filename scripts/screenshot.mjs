import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

/**
 * Screenshots and a responsive check for a running build.
 *
 *   node scripts/screenshot.mjs <url> <name> [--width 390] [--height 844] [--scale 2]
 *                               [--light] [--motion] [--slice 900] [--viewport]
 *
 * Drives an installed Chrome or Edge over the DevTools protocol, with no
 * dependency beyond Node itself. That matters for small screens: plain
 * `--window-size` cannot go below about 500px, so a "390px" capture taken that
 * way is really a 500px layout with the right-hand side cut off.
 *
 * Besides the image, it reports any text that ends up outside the viewport,
 * which is the bug a screenshot is usually being taken to find.
 *
 * Output goes to .preview/shots/. Nothing in the app imports this.
 */

const args = process.argv.slice(2);
const [url, name] = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const flag = (key) => args.includes(`--${key}`);
const option = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

if (!url || !name) {
  console.error("usage: node scripts/screenshot.mjs <url> <name> [--width N] [--height N] [--scale N] [--light] [--motion] [--slice N] [--viewport]");
  process.exit(1);
}

const width = option("width", 1440);
const height = option("height", 900);
const scale = option("scale", 1);
const slice = option("slice", 0);

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const browserPath = candidates.find((path) => existsSync(path));
if (!browserPath) {
  console.error("No Chrome or Edge found. Set CHROME_PATH.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "devlr-shot-"));
const chrome = spawn(
  browserPath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

/** Chrome prints its debugging endpoint on stderr once it is listening. */
const endpoint = await new Promise((resolveEndpoint, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("Chrome did not start in time")), 20_000);
  chrome.stderr.on("data", (chunk) => {
    buffer += chunk.toString();
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolveEndpoint(match[1]);
    }
  });
  chrome.on("exit", () => reject(new Error("Chrome exited before it was ready")));
});

const socket = new WebSocket(endpoint);
await new Promise((ok, fail) => {
  socket.addEventListener("open", ok, { once: true });
  socket.addEventListener("error", fail, { once: true });
});

let nextId = 0;
const pending = new Map();
const listeners = new Set();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { ok, fail } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) fail(new Error(`${message.error.message}`));
    else ok(message.result);
    return;
  }
  for (const listener of listeners) listener(message);
});

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}

function once(method, sessionId, timeoutMs = 30_000) {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      fail(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    const listener = (message) => {
      if (message.method === method && message.sessionId === sessionId) {
        clearTimeout(timer);
        listeners.delete(listener);
        ok(message.params);
      }
    };
    listeners.add(listener);
  });
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let exitCode = 0;
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);

  await page("Page.enable");
  await page("Runtime.enable");

  const mobile = width < 700;
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
  if (mobile) await page("Emulation.setTouchEmulationEnabled", { enabled: true });

  // Entrance animations run on the real clock, so a capture taken a moment
  // after load catches them half-finished. Reduced motion jumps every
  // animation to its end state, which is the frame worth checking. Pass
  // --motion to see the page as an ordinary visitor does.
  // The app takes its theme from localStorage (below). The email has no script
  // and follows the system setting, so that is emulated to match.
  const features = [{ name: "prefers-color-scheme", value: flag("light") ? "light" : "dark" }];
  if (!flag("motion")) features.push({ name: "prefers-reduced-motion", value: "reduce" });
  await page("Emulation.setEmulatedMedia", { features });

  // The theme is read from localStorage before first paint, so it has to be
  // set before any of the page's own scripts run.
  await page("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("theme", ${JSON.stringify(flag("light") ? "light" : "dark")}); } catch (e) {}`,
  });

  const loaded = once("Page.loadEventFired", sessionId);
  await page("Page.navigate", { url });
  await loaded;
  await page("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  // Idle callbacks, the canvas's first frame, and client-side data fetches.
  await sleep(option("wait", 1200));

  // Text whose box ends beyond the right edge, and that is not inside
  // something that scrolls or clips on purpose (a marquee, a code block).
  const check = await page("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const vw = document.documentElement.clientWidth;
      // Starts at the element itself: a line that scrolls inside its own box
      // is contained, not overflowing.
      const contained = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
        }
        return false;
      };
      // Decoration is allowed to run off the edge as far as *reading* goes.
      // It still counts when working out what makes the page too wide.
      const clipped = (el) => contained(el) || Boolean(el.closest("[aria-hidden='true']"));
      const offenders = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const el = node.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (el.closest("[aria-hidden='true']")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > vw + 1 && !clipped(el)) {
          offenders.push({
            text: node.textContent.trim().slice(0, 50),
            right: Math.round(rect.right),
            tag: el.tagName.toLowerCase(),
          });
        }
      }
      // When the page itself is too wide, name what is sticking out. Only the
      // outermost culprits: their children overflow too, and would be noise.
      const wide = [];
      if (document.documentElement.scrollWidth > vw + 1) {
        for (const el of document.body.querySelectorAll("*")) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.right <= vw + 1) continue;
          // Fixed elements follow the viewport: they are a symptom of a wide
          // page, never the cause.
          if (getComputedStyle(el).position === "fixed") continue;
          if (contained(el.parentElement ?? el)) continue;
          if (wide.some((w) => w.el.contains(el))) continue;
          wide.push({ el, right: Math.round(rect.right) });
        }
      }
      return {
        viewport: vw,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: offenders.slice(0, 12),
        wide: wide.slice(0, 6).map((w) => ({
          right: w.right,
          tag: w.el.tagName.toLowerCase(),
          cls: String(w.el.className && w.el.className.baseVal !== undefined ? w.el.className.baseVal : w.el.className).slice(0, 70),
        })),
        title: document.title,
      };
    })()`,
  });
  const report = check.result.value;

  const metrics = await page("Page.getLayoutMetrics");
  const fullHeight = flag("viewport") ? height : Math.ceil(metrics.cssContentSize.height);
  const shot = await page("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: fullHeight, scale: 1 },
  });

  const outDir = resolve(".preview", "shots");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));

  console.log(`${name}: "${report.title}" ${width}x${fullHeight} css px -> ${file}`);
  if (report.scrollWidth > report.viewport + 1) {
    exitCode = 1;
    console.log(`  PAGE SCROLLS SIDEWAYS: content is ${report.scrollWidth}px wide in a ${report.viewport}px viewport`);
    for (const w of report.wide) console.log(`    <${w.tag} class="${w.cls}"> ends at ${w.right}px`);
  }
  if (report.offenders.length > 0) {
    exitCode = 1;
    console.log(`  TEXT OUTSIDE THE VIEWPORT (${report.viewport}px):`);
    for (const o of report.offenders) console.log(`    <${o.tag}> ends at ${o.right}px: "${o.text}"`);
  }
  if (exitCode === 0) console.log("  layout ok: nothing overflows the viewport");

  // Tall pages are unreadable as one image; cut them into screens.
  if (slice > 0) {
    const pixels = Math.round(slice * scale);
    const meta = await sharp(file).metadata();
    let part = 0;
    for (let top = 0; top < meta.height; top += pixels) {
      part++;
      await sharp(file)
        .extract({ left: 0, top, width: meta.width, height: Math.min(pixels, meta.height - top) })
        .toFile(join(outDir, `${name}-${part}.png`));
    }
    console.log(`  ${part} slices: ${name}-1.png ... ${name}-${part}.png`);
  }
} catch (err) {
  exitCode = 1;
  console.error(err instanceof Error ? err.message : err);
} finally {
  try {
    await send("Browser.close");
  } catch {
    // Already gone.
  }
  socket.close();
  chrome.kill();
  // Chrome can hold the profile directory open for a moment after exiting.
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing over.
  }
}

process.exit(exitCode);
