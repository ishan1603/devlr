import { createAdminClient } from "@/lib/supabase-admin";
import { toVectorLiteral, fromVectorLiteral } from "@/lib/ai/embed";
import {
  buildAffinity,
  scoreCandidate,
  selectDiverse,
  type Candidate,
  type Scored,
} from "@/lib/content/rank";
import { loadSeen } from "@/lib/delivery/ledger";
import { feedbackLinks } from "@/lib/delivery/tokens";
import { safeHttpUrl } from "@/lib/sources/canonical";
import { userTags } from "@/lib/topics/catalog";
import type { ModuleResult, StoryItem, StoriesSection } from "@/lib/delivery/issue";
import type { ContentKind, Popularity } from "@/lib/sources/types";

/**
 * The digest: one reader's issue, assembled from the shared pool.
 *
 * Nothing here fetches, embeds or summarises. All of that happened once, at
 * ingest. This reads a few hundred candidate rows, scores them against the
 * reader, removes what they have already been shown, and picks a varied set.
 */

export interface DigestProfile {
  user_id: string;
  domains: string[];
  stack: string[];
  digest_length: "short" | "standard" | "long";
  interest_embedding: unknown;
}

const LENGTHS: Record<DigestProfile["digest_length"], number> = { short: 5, standard: 8, long: 12 };

/** Kinds that read as "what happened" rather than "something to learn from". */
const NEWS_KINDS = new Set<ContentKind>(["news", "release", "discussion"]);

interface CandidateRow {
  id: string;
  cluster_id: string | null;
  canonical_url: string;
  url: string;
  title: string;
  summary: string;
  source_id: string | null;
  source_name: string | null;
  site: string | null;
  kind: ContentKind;
  tags: string[];
  popularity: Popularity;
  pop_score: number;
  quality: number | null;
  reading_minutes: number | null;
  published_at: string | null;
  fetched_at: string;
  source_quality: number;
  similarity: number | null;
}

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    canonicalUrl: row.canonical_url,
    url: row.url,
    title: row.title,
    summary: row.summary,
    sourceId: row.source_id,
    sourceName: row.source_name ?? row.site ?? "",
    site: row.site ?? "",
    kind: row.kind,
    tags: row.tags ?? [],
    popularity: row.popularity ?? {},
    popScore: row.pop_score ?? 0,
    quality: row.quality,
    sourceQuality: row.source_quality ?? 0.5,
    readingMinutes: row.reading_minutes,
    publishedAt: row.published_at ?? row.fetched_at,
    similarity: row.similarity,
  };
}

/** The short facts under a headline. Only real numbers, never filler. */
export function metaFor(c: Pick<Candidate, "popularity" | "readingMinutes">): string[] {
  const meta: string[] = [];
  const p = c.popularity;
  if (p.hn_points && p.hn_points >= 50) meta.push(`${p.hn_points} points on HN`);
  else if (p.lobsters_score && p.lobsters_score >= 20) meta.push(`${p.lobsters_score} on Lobsters`);
  else if (p.hf_upvotes && p.hf_upvotes >= 20) meta.push(`${p.hf_upvotes} upvotes`);
  if (c.readingMinutes && c.readingMinutes >= 2) meta.push(`${c.readingMinutes} min read`);
  return meta;
}

/** Summariser ratings below this never reach a reader. */
export const MIN_QUALITY = 3;

/**
 * Put the right article at the top.
 *
 * The overall score is led by relevance, which is right for choosing what goes
 * in, but the story that opens an issue and supplies its subject line should
 * also be the one that mattered most. So among what was selected, the lead is
 * re-chosen with weight on how widely it was read and how good the source is.
 */
export function leadFirst<T extends Scored>(picked: T[]): T[] {
  if (picked.length < 2) return picked;
  const weight = (c: Scored) =>
    c.score + 0.3 * c.popScore + 0.12 * c.sourceQuality + 0.1 * ((c.quality ?? 3) - 3) / 2;

  let best = 0;
  for (let i = 1; i < picked.length; i++) {
    if (weight(picked[i]) > weight(picked[best])) best = i;
  }
  return [picked[best], ...picked.filter((_, i) => i !== best)];
}

export interface AssembleOptions {
  /** How many days back to look. */
  windowDays: number;
  /** Signed feedback links are omitted from previews and the public sample. */
  withFeedback?: boolean;
  now?: Date;
}

export async function assembleDigest(
  profile: DigestProfile,
  options: AssembleOptions
): Promise<ModuleResult & { picked: Scored[] }> {
  const supabase = createAdminClient();
  const now = options.now ?? new Date();
  const empty = { sections: [], seen: [], picked: [] };

  const tags = userTags(profile.domains, profile.stack);
  if (tags.length === 0) return empty;

  const since = new Date(now.getTime() - options.windowDays * 86_400_000).toISOString();
  const interest = fromVectorLiteral(profile.interest_embedding);

  const [{ data: rows, error }, seen, { data: feedbackRows }] = await Promise.all([
    supabase.rpc("digest_candidates", {
      p_tags: tags,
      p_embedding: interest ? toVectorLiteral(interest) : null,
      p_since: since,
      p_limit: 150,
    }),
    loadSeen(profile.user_id, "content"),
    supabase
      .from("feedback")
      .select("signal, tags, site, source_id, created_at")
      .eq("user_id", profile.user_id)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  if (error) throw new Error(`Failed to load digest candidates: ${error.message}`);

  const ctx = {
    stack: profile.stack,
    domains: profile.domains,
    affinity: buildAffinity(feedbackRows ?? [], now),
    now,
    windowDays: options.windowDays,
  };

  const scored = ((rows ?? []) as CandidateRow[])
    .map(toCandidate)
    // Already shown: by story, and by URL in case a story was re-clustered.
    .filter((c) => !(c.clusterId && seen.refs.has(c.clusterId)) && !seen.urls.has(c.canonicalUrl))
    // The summariser rated it thin or promotional. Not worth a slot.
    .filter((c) => c.quality === null || c.quality >= MIN_QUALITY)
    .map((c) => scoreCandidate(c, ctx));

  const picked = leadFirst(
    selectDiverse(scored, { count: LENGTHS[profile.digest_length] ?? LENGTHS.standard })
  );
  if (picked.length === 0) return empty;

  // Other outlets on the same stories, for "also covered by".
  const clusterIds = picked.map((p) => p.clusterId).filter(Boolean) as string[];
  const { data: siblings } = clusterIds.length
    ? await supabase
        .from("content_items")
        .select("cluster_id, source_name, site, url, canonical_url")
        .in("cluster_id", clusterIds)
    : { data: [] };

  const toStory = (c: Scored): StoryItem => {
    const ref = c.clusterId ?? c.id;
    const seenSites = new Set([c.site]);
    const alsoCoveredBy: StoryItem["alsoCoveredBy"] = [];
    for (const sibling of siblings ?? []) {
      if (sibling.cluster_id !== c.clusterId || sibling.canonical_url === c.canonicalUrl) continue;
      const site = (sibling.site as string) ?? "";
      const url = safeHttpUrl(sibling.url as string);
      if (!url || seenSites.has(site)) continue;
      seenSites.add(site);
      alsoCoveredBy.push({ name: (sibling.source_name as string) || site, url });
      if (alsoCoveredBy.length === 3) break;
    }

    return {
      ref,
      canonicalUrl: c.canonicalUrl,
      url: safeHttpUrl(c.url) || c.canonicalUrl,
      title: c.title,
      summary: c.summary,
      source: c.sourceName,
      site: c.site,
      kind: c.kind,
      tags: c.tags,
      meta: metaFor(c),
      alsoCoveredBy,
      feedback: options.withFeedback === false ? undefined : feedbackLinks(profile.user_id, ref),
    };
  };

  // The top-scored article leads the issue, whatever its kind. The rest split
  // into what happened and what is worth sitting down with.
  const [lead, ...rest] = picked;
  const news = rest.filter((c) => NEWS_KINDS.has(c.kind));
  const reads = rest.filter((c) => !NEWS_KINDS.has(c.kind));

  const sections: StoriesSection[] = [
    { type: "stories", module: "digest", label: "top story", title: "Top story", items: [toStory(lead)] },
  ];
  if (news.length > 0) {
    sections.push({ type: "stories", module: "digest", label: "news", title: "News", items: news.map(toStory) });
  }
  if (reads.length > 0) {
    sections.push({ type: "stories", module: "digest", label: "deep dives", title: "Deep dives", items: reads.map(toStory) });
  }

  return {
    sections,
    seen: picked.map((c) => ({
      module: "digest" as const,
      itemType: "content",
      ref: c.clusterId ?? c.id,
      canonicalUrl: c.canonicalUrl,
    })),
    picked,
  };
}
