import type { PoolArticle } from "@/lib/newsletter/pool";
import type { Briefing } from "@/lib/newsletter/briefing";

export interface RenderInput {
  articles: PoolArticle[];
  briefing: Briefing;
  unsubscribeUrl: string;
  dashboardUrl: string;
  date: Date;
}

/** Escape before interpolation — titles and blurbs are untrusted text. */
function esc(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s) links reach the reader; a javascript: URL must never render. */
function safeUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function groupByCategory(articles: PoolArticle[]) {
  const groups = new Map<string, PoolArticle[]>();
  for (const a of articles) {
    const list = groups.get(a.category) ?? [];
    list.push(a);
    groups.set(a.category, list);
  }
  return [...groups.entries()];
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

/**
 * Email HTML.
 *
 * Constraints that shape everything here: tables rather than flex or grid,
 * every style inline (Gmail strips <style> in some clients), no web fonts, no
 * images — an image-heavy mail with little text is a classic spam signal, and a
 * text-only briefing has nothing to load. Width is capped at 600px, the widest
 * that reliably survives Outlook.
 */
export function renderNewsletterHtml({
  articles,
  briefing,
  unsubscribeUrl,
  dashboardUrl,
  date,
}: RenderInput): string {
  const dateStr = formatDate(date);

  const sections = groupByCategory(articles)
    .map(([category, items]) => {
      const rows = items
        .map((a) => {
          const href = safeUrl(a.url);
          const title = esc(a.title);
          const blurb = esc(briefing.blurbs[a.url] ?? a.description ?? "");
          const source = a.source ? esc(a.source) : "";

          const heading = href
            ? `<a href="${href}" style="color:#17171a;text-decoration:none;font-weight:600;">${title}</a>`
            : `<span style="color:#17171a;font-weight:600;">${title}</span>`;

          return `
            <tr>
              <td style="padding:0 0 22px 0;">
                <div style="font-family:${SANS};font-size:16px;line-height:1.45;">${heading}</div>
                ${
                  source
                    ? `<div style="font-family:${SANS};font-size:12px;color:#8b8b95;padding-top:4px;">${source}</div>`
                    : ""
                }
                <div style="font-family:${SANS};font-size:14px;line-height:1.6;color:#4a4a55;padding-top:6px;">${blurb}</div>
              </td>
            </tr>`;
        })
        .join("");

      return `
        <tr>
          <td style="padding:0 0 6px 0;">
            <div style="font-family:${SANS};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#c2410c;font-weight:600;padding-bottom:14px;border-bottom:1px solid #e6e3dc;margin-bottom:18px;">${esc(
              category
            )}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
          </td>
        </tr>`;
    })
    .join("");

  const preheader = esc(briefing.intro).slice(0, 140);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Your Sendlr briefing</title>
</head>
<body style="margin:0;padding:0;background:#f4f2ee;">
  <!-- Preheader: the grey text next to the subject in most inbox lists. Without
       it, clients pull the first visible words, which reads as broken. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f2ee;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e6e3dc;border-radius:12px;">

          <tr>
            <td style="padding:32px 32px 0 32px;">
              <div style="font-family:${SERIF};font-size:26px;color:#17171a;letter-spacing:-0.3px;">Sendlr<span style="color:#c2410c;">.</span></div>
              <div style="font-family:${SANS};font-size:12px;color:#8b8b95;padding-top:6px;">${esc(dateStr)}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 32px 26px 32px;">
              <div style="font-family:${SERIF};font-size:19px;line-height:1.5;color:#17171a;">${esc(
                briefing.intro
              )}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sections}</table>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 32px 30px 32px;">
              <div style="border-top:1px solid #e6e3dc;padding-top:18px;font-family:${SANS};font-size:12px;line-height:1.7;color:#8b8b95;">
                You're receiving this because you subscribed at Sendlr.<br>
                <a href="${esc(dashboardUrl)}" style="color:#8b8b95;text-decoration:underline;">Change your topics or schedule</a>
                &nbsp;·&nbsp;
                <a href="${esc(unsubscribeUrl)}" style="color:#8b8b95;text-decoration:underline;">Unsubscribe</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The text/plain alternative.
 *
 * Sent as a real alternative rather than stripped-down HTML: a message with no
 * plain-text part scores worse with spam filters, and this is what watches,
 * screen readers and plain-text clients actually show.
 */
export function renderNewsletterText({
  articles,
  briefing,
  unsubscribeUrl,
  date,
}: RenderInput): string {
  const lines = [`SENDLR / ${formatDate(date)}`, "", briefing.intro, ""];

  for (const [category, items] of groupByCategory(articles)) {
    lines.push(category.toUpperCase(), "");
    for (const a of items) {
      lines.push(`* ${a.title}`);
      if (a.source) lines.push(`  ${a.source}`);
      lines.push(`  ${briefing.blurbs[a.url] ?? a.description ?? ""}`);
      lines.push(`  ${a.url}`, "");
    }
  }

  lines.push("---", `Unsubscribe: ${unsubscribeUrl}`);
  return lines.join("\n");
}
