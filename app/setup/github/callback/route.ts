import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { SETUP_STATE_COOKIE, envFor, setupEnabled, type CreatedApp } from "@/lib/github/manifest";
import { userAgent } from "@/lib/sources/http";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, status = 200): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
    `<style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#111;background:#fafaf7}` +
    `pre{background:#111;color:#f5f5f1;padding:16px;border-radius:10px;overflow-x:auto;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}` +
    `code{font:13px ui-monospace,monospace}h1{font-size:26px;letter-spacing:-.02em}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    // These are credentials. Nothing between here and the browser may keep them.
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/**
 * GitHub has created the App and sent the browser back with a one-time code.
 *
 * The code is exchanged for the App's credentials, which are shown once, here,
 * to the person who just created it. They are not written anywhere and not
 * logged: this response is the only copy Devlr ever makes. If the page is
 * closed before they are saved, new ones can be generated in the App's
 * settings on GitHub.
 */
export async function GET(request: NextRequest) {
  if (!setupEnabled()) return new Response("Not found", { status: 404 });

  const store = await cookies();
  const expected = store.get(SETUP_STATE_COOKIE)?.value ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const code = request.nextUrl.searchParams.get("code") ?? "";

  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return page("That did not start here", `<p>Begin again from <a href="/setup/github">the setup page</a>.</p>`, 400);
  }
  if (!/^[\w-]{10,200}$/.test(code)) {
    return page("GitHub did not send a code", `<p>Begin again from <a href="/setup/github">the setup page</a>.</p>`, 400);
  }
  store.delete(SETUP_STATE_COOKIE);

  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": userAgent() },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    return page(
      "GitHub would not hand over the App",
      `<p>It answered ${response.status}. The code is single-use and lasts an hour. Begin again from <a href="/setup/github">the setup page</a>.</p>`,
      502
    );
  }

  const app = (await response.json()) as CreatedApp;
  return page(
    `${app.name} is created`,
    `<p>Put these six lines in <code>.env.local</code>, and in your host's environment for a deployed copy. Then restart the server.</p>` +
      `<pre>${escapeHtml(envFor(app))}</pre>` +
      `<p><strong>This page is the only place they are shown.</strong> Nothing was saved or logged. If you lose them, generate a new private key and client secret in the <a href="${escapeHtml(app.html_url)}" rel="noreferrer">App's settings on GitHub</a>.</p>` +
      `<p>After restarting, open <a href="/app/repos">Repos</a> and choose Connect GitHub.</p>`
  );
}
