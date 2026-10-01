import { canonicalizeUrl, cleanUrl, siteOf } from "@/lib/sources/canonical";
import { stripEmoji } from "@/lib/ai/style";
import { titleSimhash } from "@/lib/sources/simhash";
import { NEWS_HOSTS } from "@/lib/sources/registry";
import { tagText } from "@/lib/topics/catalog";
import type { ContentKind, Popularity, RawItem } from "@/lib/sources/types";

/** A row ready for `content_items`, before enrichment. */
export interface NormalizedItem {
  canonical_url: string;
  url: string;
  title: string;
  description: string | null;
  source_id: string;
  source_name: string;
  site: string;
  author: string | null;
  kind: ContentKind;
  tags: string[];
  popularity: Popularity;
  pop_score: number;
  title_hash: string | null;
  published_at: string | null;
  /** Carried through for merge decisions; not a column. */
  source_quality: number;
  is_aggregator: boolean;
}

/**
 * Titles that are never worth a slot in someone's inbox, whatever the source.
 * LWN marks subscriber-only articles with "[$]"; linking a reader to a paywall
 * is worse than not linking at all.
 */
const JUNK_TITLE =
  /^\s*\[\$\]|\b(webinar|sponsored|giveaway|wallpapers?|podcast|coupon|black friday|cyber monday|deals? of the|we're hiring|we are hiring|job opening|register now|save the date|call for (papers|proposals|speakers))\b/i;

const RELEASE_TITLE =
  /\b(released?|release notes|changelog|is (now )?(out|available|generally available)|now available|announcing|general availability|\bGA\b|v?\d+\.\d+(\.\d+)?)\b/i;

/**
 * What kind of thing is this? The source says most of it; links that arrive
 * through an aggregator are classified by where they point.
 */
export function inferKind(raw: RawItem, site: string): ContentKind {
  if (raw.category === "research" || site === "arxiv.org") return "paper";
  if (site === "github.com") return "repo";
  if (raw.category === "tutorial") return "tutorial";
  if (raw.category === "news") return "news";
  if (raw.category === "official") return RELEASE_TITLE.test(raw.title) ? "release" : "blog";
  if (raw.category === "aggregator") {
    if (NEWS_HOSTS.has(site)) return "news";
    return "blog";
  }
  return "blog";
}

/**
 * Popularity on a 0 to 1 scale so different communities are comparable.
 *
 * Logarithmic, because the difference between 50 and 150 points says far more
 * than the difference between 1,050 and 1,150. The reference values are "a
 * clear hit" on each site.
 */
export function popularityScore(p: Popularity | undefined): number {
  if (!p) return 0;
  const scaled = (value: number | undefined, hit: number) =>
    value && value > 0 ? Math.min(1, Math.log10(value + 1) / Math.log10(hit + 1)) : 0;

  return Number(
    Math.max(
      scaled(p.hn_points, 800),
      scaled(p.lobsters_score, 120),
      scaled(p.devto_reactions, 600),
      scaled(p.hf_upvotes, 200)
    ).toFixed(4)
  );
}

export function mergePopularity(a: Popularity, b: Popularity): Popularity {
  const out: Popularity = { ...a };
  for (const key of Object.keys(b) as (keyof Popularity)[]) {
    const incoming = b[key];
    const current = out[key];
    if (typeof incoming === "number") {
      (out[key] as number) = Math.max(typeof current === "number" ? current : 0, incoming);
    } else if (incoming !== undefined && current === undefined) {
      (out[key] as string) = incoming;
    }
  }
  return out;
}

function cleanTitle(title: string): string {
  return stripEmoji(title).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Turn one fetched item into a row, or null if it should not be stored. */
export function normalizeItem(raw: RawItem): NormalizedItem | null {
  const canonical = canonicalizeUrl(raw.url);
  if (!canonical) return null;

  const title = cleanTitle(raw.title);
  if (title.length < 8 || JUNK_TITLE.test(title)) return null;

  const site = siteOf(canonical);
  const description = raw.description?.trim() || null;
  const popularity = raw.popularity ?? {};

  return {
    canonical_url: canonical,
    url: cleanUrl(raw.url) || canonical,
    title,
    description,
    source_id: raw.sourceId,
    source_name: raw.sourceName,
    site,
    author: raw.author?.slice(0, 120) || null,
    kind: inferKind(raw, site),
    tags: tagText(`${title}. ${description ?? ""}`, raw.tags),
    popularity,
    pop_score: popularityScore(popularity),
    title_hash: titleSimhash(title),
    published_at: raw.publishedAt ?? null,
    source_quality: raw.quality,
    is_aggregator: raw.category === "aggregator",
  };
}

/**
 * Collapse items that share a canonical URL.
 *
 * The usual case is an article that arrived both from its author's feed and
 * from Hacker News. The feed version wins the attribution (it names the real
 * source), and the aggregator contributes what only it has: the vote count.
 */
export function mergeByUrl(items: NormalizedItem[]): NormalizedItem[] {
  const byUrl = new Map<string, NormalizedItem>();

  for (const item of items) {
    const existing = byUrl.get(item.canonical_url);
    if (!existing) {
      byUrl.set(item.canonical_url, item);
      continue;
    }

    const primary = pickPrimary(existing, item);
    const other = primary === existing ? item : existing;
    const popularity = mergePopularity(primary.popularity, other.popularity);

    byUrl.set(item.canonical_url, {
      ...primary,
      description: primary.description ?? other.description,
      author: primary.author ?? other.author,
      published_at: earliest(primary.published_at, other.published_at),
      tags: [...new Set([...primary.tags, ...other.tags])],
      popularity,
      pop_score: popularityScore(popularity),
    });
  }

  return [...byUrl.values()];
}

function pickPrimary(a: NormalizedItem, b: NormalizedItem): NormalizedItem {
  if (a.is_aggregator !== b.is_aggregator) return a.is_aggregator ? b : a;
  return b.source_quality > a.source_quality ? b : a;
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
