import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { renderIssueHtml } from "@/lib/email/render";
import { appUrl } from "@/lib/delivery/tokens";
import type { Issue } from "@/lib/delivery/issue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function notFound() {
  return new Response("This issue is no longer available.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * "Read in browser": the issue exactly as it was sent.
 *
 * The URL is unguessable but shareable, so everything personal is removed
 * before rendering. A forwarded link must not let a stranger cast feedback as
 * the original reader, unsubscribe them, or learn their address.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!UUID.test(token)) return notFound();

  const { data } = await createAdminClient()
    .from("deliveries")
    .select("payload, status")
    .eq("web_token", token)
    .maybeSingle();

  const issue = data?.payload as Issue | null | undefined;
  if (!issue || data?.status !== "sent") return notFound();

  const shareable: Issue = {
    ...issue,
    sections: issue.sections.map((section) =>
      section.type === "stories"
        ? { ...section, items: section.items.map((item) => ({ ...item, feedback: undefined })) }
        : section
    ),
  };

  const base = appUrl();
  const html = await renderIssueHtml({
    issue: shareable,
    links: { web: `${base}/issue/${token}`, preferences: `${base}/app/settings`, unsubscribe: `${base}/app/settings` },
    recipient: "you",
  });

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A private archive, not a public page.
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, max-age=300",
    },
  });
}
