import { fetchJSON, htmlToText } from "@/lib/sources/http";
import { isTag } from "@/lib/topics/catalog";
import type { FetchResult, RawItem, SourceDef } from "@/lib/sources/types";

/**
 * Community sources. Unlike a feed, each of these comes with a vote count,
 * which is the best free signal there is for "developers found this worth
 * reading". Every fetcher applies a floor so only what cleared it is stored.
 */

function base(source: SourceDef) {
  return {
    sourceId: source.id,
    sourceName: source.name,
    category: source.category,
    quality: source.quality,
  };
}

// ---------------------------------------------------------------------------
// Hacker News (Algolia search API: public, keyless)
// ---------------------------------------------------------------------------

const HN_MIN_POINTS = 60;
const HN_WINDOW_HOURS = 48;

interface HnHit {
  objectID: string;
  title?: string;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string;
  author?: string;
}

export async function fetchHackerNews(source: SourceDef): Promise<FetchResult> {
  const since = Math.floor(Date.now() / 1000) - HN_WINDOW_HOURS * 3600;
  const url = `${source.url}&numericFilters=${encodeURIComponent(
    `created_at_i>${since},points>${HN_MIN_POINTS}`
  )}`;
  const data = await fetchJSON<{ hits: HnHit[] }>(url);

  const items: RawItem[] = [];
  for (const hit of data.hits ?? []) {
    // Text posts ("Ask HN") have no article to link to. The digest links out,
    // so they are skipped rather than pointed at a comment thread.
    if (!hit.url || !hit.title) continue;
    items.push({
      ...base(source),
      url: hit.url,
      title: hit.title.replace(/^(Show|Launch|Tell) HN:\s*/i, ""),
      author: hit.author,
      publishedAt: hit.created_at,
      tags: [],
      popularity: {
        hn_points: hit.points ?? 0,
        hn_comments: hit.num_comments ?? 0,
        hn_id: hit.objectID,
      },
    });
  }
  return { items };
}

// ---------------------------------------------------------------------------
// Lobsters
// ---------------------------------------------------------------------------

const LOBSTERS_MIN_SCORE = 15;

/** Lobsters tags that map onto ours. Anything else is left to keyword tagging. */
const LOBSTERS_TAGS: Record<string, string[]> = {
  rust: ["rust"], go: ["go"], python: ["python"], javascript: ["javascript"], ruby: ["ruby"],
  php: ["php"], java: ["java"], kotlin: ["kotlin"], swift: ["swift"], elixir: ["elixir"],
  zig: ["zig"], "c++": ["cpp"], dotnet: ["csharp"], nodejs: ["nodejs"], web: ["frontend"],
  css: ["frontend"], browsers: ["frontend"], wasm: ["webassembly"], security: ["security"],
  ai: ["ai"], vibecoding: ["ai", "llm"], databases: ["data", "backend"], sql: ["data"],
  devops: ["devops"], linux: ["linux"], unix: ["systems"], performance: ["systems"],
  compilers: ["systems"], osdev: ["systems"], distributed: ["backend"], api: ["backend"],
  scaling: ["backend"], networking: ["systems"], hardware: ["systems"], games: ["gamedev"],
  mobile: ["mobile"], android: ["mobile"], ios: ["mobile"], practices: ["leadership"],
  culture: ["leadership"], vcs: ["git"], testing: ["testing"], editors: ["tooling"],
  programming: [], virtualization: ["devops"], containers: ["docker", "devops"],
};

interface LobstersStory {
  title: string;
  url: string;
  score: number;
  comment_count: number;
  created_at: string;
  tags: string[];
  submitter_user?: string;
  description_plain?: string;
}

export async function fetchLobsters(source: SourceDef): Promise<FetchResult> {
  const stories = await fetchJSON<LobstersStory[]>(source.url);

  const items: RawItem[] = [];
  for (const story of stories ?? []) {
    if (!story.url || !story.title || story.score < LOBSTERS_MIN_SCORE) continue;
    items.push({
      ...base(source),
      url: story.url,
      title: story.title,
      description: htmlToText(story.description_plain),
      author: story.submitter_user,
      publishedAt: story.created_at,
      tags: [...new Set((story.tags ?? []).flatMap((t) => LOBSTERS_TAGS[t] ?? []))],
      popularity: { lobsters_score: story.score, lobsters_comments: story.comment_count },
    });
  }
  return { items };
}

// ---------------------------------------------------------------------------
// DEV (Forem API: public, keyless)
// ---------------------------------------------------------------------------

const DEVTO_MIN_REACTIONS = 40;

const DEVTO_TAGS: Record<string, string[]> = {
  webdev: ["frontend"], node: ["nodejs"], ai: ["ai"], machinelearning: ["ai"], llm: ["llm", "ai"],
  database: ["data"], sql: ["data"], cloud: ["devops"], security: ["security"],
  cybersecurity: ["security"], opensource: ["tooling"], career: ["leadership"],
  architecture: ["backend"], systemdesign: ["backend"], css: ["frontend"], html: ["frontend"],
  reactnative: ["react-native"], postgres: ["postgres"], postgresql: ["postgres"],
  githubactions: ["github-actions"], k8s: ["kubernetes"], golang: ["go"], dotnet: ["csharp"],
  gamedev: ["gamedev"], android: ["mobile"], ios: ["mobile"], testing: ["testing"],
};

interface DevtoArticle {
  title: string;
  description?: string;
  url: string;
  canonical_url?: string;
  published_at?: string;
  tag_list?: string[];
  public_reactions_count?: number;
  comments_count?: number;
  user?: { name?: string };
}

export async function fetchDevto(source: SourceDef): Promise<FetchResult> {
  const articles = await fetchJSON<DevtoArticle[]>(source.url);

  const items: RawItem[] = [];
  for (const article of articles ?? []) {
    const reactions = article.public_reactions_count ?? 0;
    if (!article.url || !article.title || reactions < DEVTO_MIN_REACTIONS) continue;

    const tags = (article.tag_list ?? []).flatMap((t) => {
      const tag = t.toLowerCase();
      return DEVTO_TAGS[tag] ?? (isTag(tag) ? [tag] : []);
    });

    items.push({
      ...base(source),
      // A cross-post names the original; link there so it dedupes with the
      // author's own feed instead of appearing twice.
      url: article.canonical_url || article.url,
      title: article.title,
      description: htmlToText(article.description),
      author: article.user?.name,
      publishedAt: article.published_at,
      tags: [...new Set(tags)],
      popularity: { devto_reactions: reactions, devto_comments: article.comments_count ?? 0 },
    });
  }
  return { items };
}

// ---------------------------------------------------------------------------
// Hugging Face daily papers (a curated, voted view of arXiv)
// ---------------------------------------------------------------------------

const HF_MIN_UPVOTES = 15;

interface HfPaper {
  paper?: { id?: string; title?: string; summary?: string; upvotes?: number; publishedAt?: string };
  publishedAt?: string;
}

export async function fetchHfPapers(source: SourceDef): Promise<FetchResult> {
  const papers = await fetchJSON<HfPaper[]>(source.url);

  const items: RawItem[] = [];
  for (const entry of papers ?? []) {
    const paper = entry.paper;
    const upvotes = paper?.upvotes ?? 0;
    if (!paper?.id || !paper.title || upvotes < HF_MIN_UPVOTES) continue;
    items.push({
      ...base(source),
      // Link the paper itself, so an HN submission of the same arXiv id merges.
      url: `https://arxiv.org/abs/${paper.id}`,
      title: paper.title.replace(/\s+/g, " ").trim(),
      description: htmlToText(paper.summary),
      publishedAt: entry.publishedAt ?? paper.publishedAt,
      tags: source.topics,
      popularity: { hf_upvotes: upvotes },
    });
  }
  return { items };
}
