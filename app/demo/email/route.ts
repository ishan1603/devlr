import type { NextRequest } from "next/server";
import { demoEnabled } from "@/lib/demo";
import { demoGuardIssue } from "@/lib/demo-repos";
import { renderIssueHtml } from "@/lib/email/render";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import type { Issue } from "@/lib/delivery/issue";

/**
 * A sample issue, rendered with the real email template.
 *
 * This is the exact HTML a mail client would receive, so it is the quickest
 * way to see a template change.
 *
 *   /demo/email               a regular issue
 *   /demo/email?view=guard    the same, led by Repo Guard findings
 *   /demo/email?view=alert    the alert that goes out on its own
 *
 * Feedback links are added, pointing nowhere, because they are part of the
 * layout.
 */
export async function GET(request: NextRequest) {
  if (!demoEnabled()) return new Response("Not found", { status: 404 });

  const view = request.nextUrl.searchParams.get("view");
  const base = view === "alert" ? demoGuardIssue("alert") : view === "guard" ? demoGuardIssue("bundled") : SAMPLE_ISSUE;

  const issue: Issue = {
    ...base,
    sections: base.sections.map((section) =>
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
