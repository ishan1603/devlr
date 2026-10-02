import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { appUrl } from "@/lib/delivery/tokens";
import { shareable, type Issue } from "@/lib/delivery/issue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A compact HTML body for feed readers: the intro, then each section as a list. */
function entryHtml(issue: Issue): string {
  const parts: string[] = [];
  if (issue.intro) parts.push(`<p>${xml(issue.intro)}</p>`);

  for (const section of issue.sections) {
    parts.push(`<h3>${xml(section.title)}</h3><ul>`);
    if (section.type === "stories") {
      for (const item of section.items) {
        parts.push(`<li><a href="${xml(item.url)}">${xml(item.title)}</a> (${xml(item.site)})<br>${xml(item.summary)}</li>`);
      }
    } else if (section.type === "repos") {
      for (const repo of section.repos) {
        parts.push(`<li><a href="${xml(repo.url)}">${xml(repo.fullName)}</a>, ${repo.stars} stars<br>${xml(repo.description)}</li>`);
      }
    } else if (section.type === "guard") {
      // A feed is fetched and stored by whatever reader it is pasted into, so
      // it only ever says that there is something to look at.
      parts.push(`<li>There are findings about your repositories. <a href="${xml(section.url)}">Open Repo Guard</a></li>`);
    } else {
      for (const entry of section.entries) {
        parts.push(`<li>${xml(entry.product)} ${xml(entry.cycle)}: end of life ${xml(entry.eolDate)}</li>`);
      }
    }
    parts.push("</ul>");
  }
  return parts.join("");
}

/**
 * A reader's issues as an Atom feed.
 *
 * Some people would rather not get email at all. The feed token is separate
 * from the unsubscribe token so that pasting a feed URL into a reader, or
 * sharing it, never hands over the ability to change someone's settings.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!UUID.test(token)) return new Response("Not found", { status: 404 });

  const supabase = createAdminClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("feed_token", token)
    .maybeSingle();
  if (!profile) return new Response("Not found", { status: 404 });

  const { data: deliveries } = await supabase
    .from("deliveries")
    .select("web_token, payload, sent_at")
    .eq("user_id", profile.user_id)
    .eq("status", "sent")
    .not("payload", "is", null)
    .order("sent_at", { ascending: false })
    .limit(20);

  const base = appUrl();
  const self = `${base}/feed/${token}`;
  const updated = deliveries?.[0]?.sent_at ?? new Date().toISOString();

  const entries = (deliveries ?? [])
    .map((delivery) => {
      const issue = shareable(delivery.payload as Issue);
      const link = `${base}/issue/${delivery.web_token}`;
      return [
        "<entry>",
        `<title>${xml(issue.subject)}</title>`,
        `<link href="${xml(link)}"/>`,
        `<id>${xml(link)}</id>`,
        `<updated>${xml(delivery.sent_at as string)}</updated>`,
        `<summary>${xml(issue.preheader || issue.intro)}</summary>`,
        `<content type="html">${xml(entryHtml(issue))}</content>`,
        "</entry>",
      ].join("");
    })
    .join("");

  const feed =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<feed xmlns="http://www.w3.org/2005/Atom">` +
    `<title>Devlr</title>` +
    `<subtitle>Your Devlr issues</subtitle>` +
    `<link href="${xml(self)}" rel="self"/>` +
    `<link href="${xml(base)}"/>` +
    `<id>${xml(self)}</id>` +
    `<updated>${xml(updated as string)}</updated>` +
    `<author><name>Devlr</name></author>` +
    entries +
    `</feed>`;

  return new Response(feed, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": "private, max-age=900",
    },
  });
}
