import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { politeFetch } from "@/lib/sources/http";

/**
 * Main-text extraction.
 *
 * A summary written from a headline alone is a guess. This fetches the article
 * and pulls out its body so the summariser has something real to work from.
 * Best effort by design: any failure returns null and the caller falls back to
 * the feed's own description.
 */

export interface Extracted {
  /** The opening of the article, enough to summarise from. */
  excerpt: string;
  /** Estimated reading time for the whole piece, in minutes. */
  readingMinutes: number;
}

const EXCERPT_CHARS = 2200;
/** Refuse to parse enormous pages; the parser is synchronous. */
const MAX_HTML_BYTES = 1_500_000;
const WORDS_PER_MINUTE = 220;

/** Sites where fetching the page adds nothing, or that we should not hit. */
const SKIP_HOSTS = new Set([
  "arxiv.org", "github.com", "youtube.com", "youtu.be", "twitter.com", "x.com",
  "news.ycombinator.com", "reddit.com", "linkedin.com",
]);

export function extractFromHtml(html: string): Extracted | null {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document, { charThreshold: 300 }).parse();
  const text = article?.textContent?.replace(/\s+/g, " ").trim();
  if (!text || text.length < 300) return null;

  const words = text.split(" ").length;
  return {
    excerpt: text.slice(0, EXCERPT_CHARS),
    readingMinutes: Math.max(1, Math.min(60, Math.round(words / WORDS_PER_MINUTE))),
  };
}

export async function extractArticle(url: string): Promise<Extracted | null> {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (SKIP_HOSTS.has(host)) return null;

    const response = await politeFetch(url, { accept: "text/html", timeoutMs: 10_000 });
    if (!response.ok) return null;
    if (!/html/i.test(response.headers.get("content-type") ?? "")) return null;

    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) return null;

    return extractFromHtml(html);
  } catch {
    return null;
  }
}
