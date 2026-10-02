import * as React from "react";
import { render } from "@react-email/render";
import IssueEmail, { eolPhrase, type IssueEmailProps } from "@/lib/email/IssueEmail";
import { formatStars } from "@/lib/modules/pulse";
import type { Issue } from "@/lib/delivery/issue";

export async function renderIssueHtml(props: IssueEmailProps): Promise<string> {
  return render(React.createElement(IssueEmail, props));
}

/**
 * The text/plain alternative.
 *
 * Written by hand rather than derived from the HTML. A message with no real
 * plain-text part scores worse with spam filters, and this is what watches,
 * screen readers and terminal mail clients actually show, which for this
 * audience is not a rounding error.
 */
export function renderIssueText({ issue, links }: Pick<IssueEmailProps, "issue" | "links">): string {
  const lines: string[] = [`DEVLR  ${issue.date.slice(0, 10)}`, ""];
  if (issue.intro) lines.push(issue.intro, "");

  for (const section of issue.sections) {
    lines.push(`// ${section.label}`, "");

    if (section.type === "stories") {
      for (const item of section.items) {
        lines.push(item.title);
        const meta = [item.site, ...item.meta].filter(Boolean);
        if (meta.length) lines.push(meta.join(" | "));
        lines.push(item.summary, item.url);
        if (item.alsoCoveredBy.length) {
          lines.push(`Also covered by: ${item.alsoCoveredBy.map((o) => o.name).join(", ")}`);
        }
        lines.push("");
      }
    } else if (section.type === "repos") {
      for (const repo of section.repos) {
        lines.push(
          `${repo.fullName}  (${formatStars(repo.stars)} stars${repo.language ? `, ${repo.language}` : ""})`,
          repo.blurb || repo.description,
          repo.url,
          ""
        );
      }
    } else if (section.type === "guard") {
      if (section.redacted) {
        lines.push(`Details are in your account: ${section.url}`, "");
        continue;
      }
      for (const repo of section.repos) {
        lines.push(`${repo.fullName}  ${repo.grade} ${repo.score}/100, ${repo.toFix} to fix`);
      }
      if (section.repos.length) lines.push("");
      for (const entry of section.entries) {
        lines.push(`[${entry.priority}] ${entry.repo}`, entry.title);
        if (entry.meta.length) lines.push(entry.meta.join(" | "));
        lines.push(entry.action);
        if (entry.command) lines.push(`$ ${entry.command}`);
        lines.push(entry.url, "");
      }
      if (section.also.length) lines.push(`Also needs attention: ${section.also.join(", ")}.`);
      lines.push(`Every finding: ${section.url}`, "");
    } else {
      for (const entry of section.entries) {
        lines.push(
          `${entry.product} ${entry.cycle}: end of life ${entry.eolDate} (${eolPhrase(entry.daysLeft)})` +
            (entry.latest ? `, current is ${entry.latest}` : "")
        );
        if (entry.link) lines.push(entry.link);
        lines.push("");
      }
    }
  }

  lines.push(
    "--",
    `Change what you get: ${links.preferences}`,
    `Read in browser: ${links.web}`,
    `Unsubscribe: ${links.unsubscribe}`
  );
  return lines.join("\n");
}

export type { Issue };
