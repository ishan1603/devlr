import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { appUrl } from "@/lib/delivery/tokens";
import { SETUP_STATE_COOKIE, appManifest, setupEnabled } from "@/lib/github/manifest";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Hands the manifest to GitHub.
 *
 * GitHub takes a manifest as a form POST from the browser, so this answers
 * with a page whose only content is that form, submitted as soon as it loads.
 * The random `state` is kept in a cookie and checked when GitHub sends the
 * browser back, so the callback only acts on a round trip that started here.
 */
export async function GET() {
  if (!setupEnabled()) return new Response("Not found", { status: 404 });

  const state = randomBytes(16).toString("hex");
  (await cookies()).set(SETUP_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/setup/github",
    maxAge: 60 * 60,
  });

  const manifest = JSON.stringify(appManifest(appUrl()));
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opening GitHub</title></head>` +
    `<body><form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}">` +
    `<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">` +
    // Submitted by the script below. The button is for a browser where that does not run.
    `<p style="font:15px system-ui,sans-serif;margin:48px">Opening GitHub. <button type="submit">Continue</button></p>` +
    `</form><script>document.getElementById("f").submit()</script></body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
