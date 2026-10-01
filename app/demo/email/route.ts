import { demoEnabled } from "@/lib/demo";
import { renderIssueHtml } from "@/lib/email/render";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import type { Issue } from "@/lib/delivery/issue";

/**
 * The sample issue, rendered with the real email template.
 *
 * This is the exact HTML a mail client would receive, so it is the quickest
 * way to see a template change. Feedback links are added, pointing nowhere,
 * because they are part of the layout.
 */
export async function GET() {
  if (!demoEnabled()) return new Response("Not found", { status: 404 });

  const issue: Issue = {
    ...SAMPLE_ISSUE,
    sections: SAMPLE_ISSUE.sections.map((section) =>
      section.type === "stories"
        ? { ...section, items: section.items.map((item) => ({ ...item, feedback: { more: "#", less: "#" } })) }
        : section
    ),
  };

  const html = await renderIssueHtml({
    issue,
    links: { web: "#", preferences: "/demo/app/schedule", unsubscribe: "#", feed: "#" },
    recipient: "ada@example.com",
  });

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
