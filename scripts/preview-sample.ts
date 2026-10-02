import { mkdir, writeFile } from "node:fs/promises";

import { demoGuardIssue } from "@/lib/demo-repos";
import { renderIssueHtml, renderIssueText } from "@/lib/email/render";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";

/**
 * Render sample issues to .preview/.
 *
 *   npm run email:sample
 *
 * Writes three: a regular issue (sample), one led by Repo Guard findings
 * (sample-guard), and the alert that goes out on its own (sample-alert), each
 * as .html and .txt.
 *
 * No network, no keys, no database: the same fixed issues every time. This is
 * the one to use when changing the template, because two runs can be diffed.
 * `npm run email:preview` builds a real issue from live sources instead.
 */

const links = {
  web: "https://devlr.example/issue/sample",
  preferences: "https://devlr.example/app/topics",
  unsubscribe: "https://devlr.example/api/unsubscribe?token=sample",
  feed: "https://devlr.example/feed/sample",
};

async function main() {
  await mkdir(".preview", { recursive: true });

  const samples = {
    sample: SAMPLE_ISSUE,
    "sample-guard": demoGuardIssue("bundled"),
    "sample-alert": demoGuardIssue("alert"),
  };

  for (const [name, issue] of Object.entries(samples)) {
    const html = await renderIssueHtml({ issue, links, recipient: "you@example.com" });
    await writeFile(`.preview/${name}.html`, html);
    await writeFile(`.preview/${name}.txt`, renderIssueText({ issue, links }));
    console.log(`.preview/${name}.html  ${(html.length / 1024).toFixed(1)} KB  "${issue.subject}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
