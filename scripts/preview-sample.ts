import { mkdir, writeFile } from "node:fs/promises";

import { renderIssueHtml, renderIssueText } from "@/lib/email/render";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";

/**
 * Render the sample issue to .preview/sample.{html,txt}.
 *
 *   npm run email:sample
 *
 * No network, no keys, no database: the same fixed issue every time. This is
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
  const out = process.argv[2] ?? "sample";
  await mkdir(".preview", { recursive: true });
  const html = await renderIssueHtml({ issue: SAMPLE_ISSUE, links, recipient: "you@example.com" });
  await writeFile(`.preview/${out}.html`, html);
  await writeFile(`.preview/${out}.txt`, renderIssueText({ issue: SAMPLE_ISSUE, links }));
  console.log(`.preview/${out}.html  ${(html.length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
