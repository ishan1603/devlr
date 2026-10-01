import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCES } from "@/lib/sources/registry";
import { fetchSource } from "@/lib/sources/fetch";
import { fetchJSON, mapLimit } from "@/lib/sources/http";
import { extractArticle } from "@/lib/sources/extract";
import { sameStoryByTitle } from "@/lib/sources/simhash";
import { mergeByUrl, normalizeItem, type NormalizedItem } from "@/lib/content/normalize";
import { scoreCandidate, selectDiverse, type Candidate } from "@/lib/content/rank";
import { SUMMARY_BATCH_SIZE, fallbackSummary, summarizeBatch } from "@/lib/content/summarize";
import { editIssue, interestNames } from "@/lib/delivery/editor";
import { leadFirst, metaFor } from "@/lib/modules/digest";
import { isMostlyLatin } from "@/lib/modules/pulse";
import { daysUntil, milestoneFor } from "@/lib/modules/eol";
import { eolProductsFor, githubLanguagesFor, sanitizeTags } from "@/lib/topics/catalog";
import { cleanProse } from "@/lib/ai/style";
import { renderIssueHtml, renderIssueText } from "@/lib/email/render";
import type { Issue, Section, StoryItem } from "@/lib/delivery/issue";

/**
 * Build a real issue from live sources and write it to disk, with no database.
 *
 *   npm run email:preview
 *   npm run email:preview -- --domains backend,ai --stack postgres,python,llm
 *   npm run email:preview -- --no-ai
 *
 * It runs the same fetchers, ranking, summariser, editor and template as a
 * real send. What it skips is everything that needs state: seen-history,
 * embeddings and feedback. Use it to judge the email, not the personalisation.
 */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const domains = sanitizeTags(arg("domains", "backend,frontend").split(","));
const stack = sanitizeTags(arg("stack", "typescript,nextjs,react,postgres,nodejs").split(","));
const useAi = !process.argv.includes("--no-ai");
const count = Number(arg("count", "8"));

async function main() {
  if (!useAi) {
    for (const key of ["GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY"]) {
      delete process.env[key];
    }
  }

  console.log(`Reader: domains=[${domains}] stack=[${stack}] ai=${useAi}`);
  console.log(`Fetching ${SOURCES.length} sources...`);

  const fetched = await mapLimit(SOURCES, 6, (s) => fetchSource(s));
  const failed = fetched.filter((f) => f.error);
  const items = mergeByUrl(
    fetched.flatMap((f) => f.result?.items ?? []).map(normalizeItem).filter(Boolean) as NormalizedItem[]
  );
  console.log(`  ${items.length} unique items, ${failed.length} sources failed`);

  // In-memory stand-in for clustering: title matching only.
  const clusters: NormalizedItem[][] = [];
  for (const item of items) {
    const home = clusters.find((c) => sameStoryByTitle(c[0].title, item.title));
    if (home) home.push(item);
    else clusters.push([item]);
  }

  const now = new Date();
  const ctx = { stack, domains, affinity: new Map<string, number>(), now, windowDays: 7 };
  const quality = new Map(SOURCES.map((s) => [s.id, s.quality]));

  const candidates: Candidate[] = clusters.flatMap((cluster, index) =>
    cluster.map((item) => ({
      id: item.canonical_url,
      clusterId: `c${index}`,
      canonicalUrl: item.canonical_url,
      url: item.url,
      title: item.title,
      summary: fallbackSummary(item.description ?? ""),
      sourceId: item.source_id,
      sourceName: item.source_name,
      site: item.site,
      kind: item.kind,
      tags: item.tags,
      popularity: item.popularity,
      popScore: item.pop_score,
      quality: null,
      sourceQuality: quality.get(item.source_id) ?? 0.5,
      readingMinutes: null,
      publishedAt: item.published_at ?? now.toISOString(),
      similarity: null,
    }))
  );

  const picked = leadFirst(
    selectDiverse(
      candidates.map((c) => scoreCandidate(c, ctx)),
      { count }
    )
  );
  console.log(`  ${clusters.length} stories, picked ${picked.length}`);

  // Extract and summarise only what made the cut.
  const bodies = await mapLimit(picked, 4, (p) => extractArticle(p.url));
  const bodyOf = new Map(bodies.map((b) => [b.item.id, b.result ?? null]));

  const summaries = new Map<string, { summary: string; ai: boolean }>();
  for (let i = 0; i < picked.length; i += SUMMARY_BATCH_SIZE) {
    const batch = picked.slice(i, i + SUMMARY_BATCH_SIZE);
    const out = await summarizeBatch(
      batch.map((p) => ({
        id: p.id,
        title: p.title,
        sourceName: p.sourceName,
        text: bodyOf.get(p.id)?.excerpt || p.summary || p.title,
        kind: p.kind,
        tags: p.tags,
      }))
    );
    for (const o of out) summaries.set(o.id, { summary: o.summary, ai: o.aiGenerated });
  }

  const toStory = (p: (typeof picked)[number]): StoryItem => {
    const index = Number(p.clusterId!.slice(1));
    const others = clusters[index].filter((o) => o.canonical_url !== p.canonicalUrl && o.site !== p.site);
    return {
      ref: p.clusterId!,
      canonicalUrl: p.canonicalUrl,
      url: p.url,
      title: p.title,
      summary: summaries.get(p.id)?.summary || p.summary || p.title,
      source: p.sourceName,
      site: p.site,
      kind: p.kind,
      tags: p.tags,
      meta: metaFor({ popularity: p.popularity, readingMinutes: bodyOf.get(p.id)?.readingMinutes ?? null }),
      alsoCoveredBy: others.slice(0, 3).map((o) => ({ name: o.source_name, url: o.url })),
      feedback: { more: "https://devlr.vercel.app/f/preview", less: "https://devlr.vercel.app/f/preview" },
    };
  };

  const sections: Section[] = [];
  if (picked.length > 0) {
    const [lead, ...rest] = picked;
    const isNews = (p: (typeof picked)[number]) => ["news", "release", "discussion"].includes(p.kind);
    sections.push({ type: "stories", module: "digest", label: "top story", title: "Top story", items: [toStory(lead)] });
    const news = rest.filter(isNews);
    const reads = rest.filter((p) => !isNews(p));
    if (news.length) sections.push({ type: "stories", module: "digest", label: "news", title: "News", items: news.map(toStory) });
    if (reads.length) sections.push({ type: "stories", module: "digest", label: "deep dives", title: "Deep dives", items: reads.map(toStory) });
  }

  // EOL Watch, straight from endoflife.date.
  const eolEntries = [];
  for (const { product, name } of eolProductsFor(stack)) {
    try {
      const cycles = await fetchJSON<{ cycle: string; eol?: string | boolean; releaseDate?: string; link?: string }[]>(
        `https://endoflife.date/api/${product}.json`
      );
      const newest = cycles[0]?.cycle;
      for (const c of cycles) {
        if (typeof c.eol !== "string") continue;
        const daysLeft = daysUntil(c.eol, now);
        const milestone = milestoneFor(daysLeft);
        if (milestone === null) continue;
        eolEntries.push({
          ref: `${product}:${c.cycle}:${milestone}`,
          product: name,
          cycle: String(c.cycle),
          eolDate: c.eol,
          daysLeft,
          latest: newest && String(newest) !== String(c.cycle) ? String(newest) : undefined,
          link: c.link ?? `https://endoflife.date/${product}`,
        });
      }
    } catch {
      // A preview does not fail over one product.
    }
  }
  if (eolEntries.length) {
    eolEntries.sort((a, b) => a.daysLeft - b.daysLeft);
    sections.push({ type: "eol", module: "eol_watch", label: "eol watch", title: "Reaching end of life", entries: eolEntries });
  }

  // Dev Pulse, straight from GitHub search (unauthenticated, one request).
  const language = githubLanguagesFor(stack)[0];
  if (language) {
    try {
      const since = new Date(now.getTime() - 21 * 86_400_000).toISOString().slice(0, 10);
      const gh = await fetchJSON<{ items: any[] }>(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(
          `created:>${since} language:"${language}" stars:>40`
        )}&sort=stars&order=desc&per_page=10`,
        { headers: { accept: "application/vnd.github+json" } }
      );
      const repos = gh.items
        .filter((r) => !r.fork && (r.description ?? "").trim().length >= 12 && isMostlyLatin(r.description))
        .slice(0, 4)
        .map((r) => ({
          fullName: r.full_name as string,
          url: r.html_url as string,
          description: cleanProse(r.description ?? "").slice(0, 280),
          language,
          stars: r.stargazers_count as number,
        }));
      if (repos.length) {
        sections.push({ type: "repos", module: "dev_pulse", label: "dev pulse", title: "New and climbing on GitHub", repos });
      }
    } catch {
      // Rate limited or offline: the preview goes ahead without it.
    }
  }

  const copy = await editIssue({ sections, interests: interestNames(domains, stack), previousIntros: [], date: now });
  const issue: Issue = { ...copy, date: now.toISOString(), sections };

  const links = {
    web: "https://devlr.vercel.app/issue/preview",
    preferences: "https://devlr.vercel.app/app/settings",
    unsubscribe: "https://devlr.vercel.app/unsubscribe?token=preview",
    feed: "https://devlr.vercel.app/feed/preview",
  };
  const html = await renderIssueHtml({ issue, links, recipient: "you@example.com" });
  const text = renderIssueText({ issue, links });

  const outDir = join(process.cwd(), ".preview");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "issue.html"), html);
  writeFileSync(join(outDir, "issue.txt"), text);
  writeFileSync(join(outDir, "issue.json"), JSON.stringify(issue, null, 2));

  const aiSummaries = [...summaries.values()].filter((s) => s.ai).length;
  console.log(`\nSubject:   ${issue.subject}`);
  console.log(`Preheader: ${issue.preheader}`);
  console.log(`Intro:     ${issue.intro}`);
  console.log(`\nEditor: ${issue.aiEdited ? "model" : "template"}. Summaries: ${aiSummaries}/${picked.length} by model.`);
  console.log(`HTML ${(html.length / 1024).toFixed(1)} KB -> .preview/issue.html (open it in a browser)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
