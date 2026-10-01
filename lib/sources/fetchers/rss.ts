import { XMLParser } from "fast-xml-parser";
import { htmlToText, politeFetch } from "@/lib/sources/http";
import type { FetchResult, FetchState, RawItem, SourceDef } from "@/lib/sources/types";

/** A feed can carry years of history; only the recent end is news. */
const MAX_ITEMS_PER_FEED = 25;
const MAX_AGE_MS = 14 * 86_400_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Keep everything as strings: a title of "1.90" must not become the number 1.9.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Feeds are untrusted XML. Entity expansion is where XML bombs live.
  processEntities: true,
  htmlEntities: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Text of a node that may be a string, a CDATA wrapper, or `{ "#text": ... }`. */
function text(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("#text" in obj) return text(obj["#text"]);
    if ("__cdata" in obj) return text(obj.__cdata);
  }
  return "";
}

/** Atom links are elements with attributes; pick the article, not the feed. */
function atomLink(link: unknown): string {
  const links = asArray(link as any);
  const alternate =
    links.find((l) => typeof l === "object" && (l["@_rel"] === "alternate" || !l["@_rel"])) ??
    links[0];
  if (!alternate) return "";
  return typeof alternate === "string" ? alternate : (alternate["@_href"] ?? text(alternate));
}

/**
 * Feeds sometimes date an item in the future (an event listing, a timezone
 * slip). Left alone it would outrank everything on recency for months, so it is
 * pulled back to now.
 */
function toIso(value: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(Math.min(time, Date.now())).toISOString();
}

function absolutise(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * Parse RSS 2.0, Atom and RDF into one shape. Exported for tests: it is pure,
 * and feed formats are exactly the kind of thing that breaks quietly.
 */
export function parseFeed(xml: string, source: SourceDef): RawItem[] {
  const doc = parser.parse(xml) as Record<string, any>;

  const base = {
    sourceId: source.id,
    sourceName: source.name,
    category: source.category,
    quality: source.quality,
    tags: source.topics,
  };

  const items: RawItem[] = [];

  // RSS 2.0 and RDF (RSS 1.0, which puts items beside the channel).
  const rssItems = asArray(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
  for (const item of rssItems) {
    const link = text(item.link) || text(item.guid);
    const title = htmlToText(text(item.title), 300);
    if (!link || !title) continue;
    items.push({
      ...base,
      url: absolutise(link, source.url),
      title,
      description: htmlToText(text(item.description) || text(item["content:encoded"])),
      author: text(item["dc:creator"]) || text(item.author) || undefined,
      publishedAt: toIso(text(item.pubDate) || text(item["dc:date"])),
    });
  }

  // Atom.
  for (const entry of asArray(doc.feed?.entry)) {
    const link = atomLink(entry.link) || text(entry.id);
    const title = htmlToText(text(entry.title), 300);
    if (!link || !title) continue;
    items.push({
      ...base,
      url: absolutise(link, source.url),
      title,
      description: htmlToText(text(entry.summary) || text(entry.content)),
      author: text(asArray(entry.author)[0]?.name) || undefined,
      publishedAt: toIso(text(entry.published) || text(entry.updated)),
    });
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  return items
    .filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff)
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, MAX_ITEMS_PER_FEED);
}

/**
 * Fetch one feed with a conditional GET.
 *
 * Most polls of most feeds find nothing new. Sending the validators back means
 * the server answers 304 with no body, which is cheaper for both sides and is
 * what a well-behaved reader does.
 */
export async function fetchRss(source: SourceDef, state: FetchState = {}): Promise<FetchResult> {
  const headers: Record<string, string> = {};
  if (state.etag) headers["if-none-match"] = state.etag;
  if (state.lastModified) headers["if-modified-since"] = state.lastModified;

  const response = await politeFetch(source.url, {
    headers,
    accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  });

  if (response.status === 304) return { items: [], notModified: true };
  if (!response.ok) throw new Error(`feed answered ${response.status}`);

  const xml = await response.text();
  // A 200 with an HTML body is a feed that moved or a bot wall, not a feed.
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 2000))) {
    throw new Error("response is not an RSS or Atom document");
  }

  return {
    items: parseFeed(xml, source),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}
