import { createAdminClient } from "@/lib/supabase-admin";
import { embedTexts, toVectorLiteral } from "@/lib/ai/embed";
import { extractArticle } from "@/lib/sources/extract";
import { mapLimit } from "@/lib/sources/http";
import { sameStoryByTitle } from "@/lib/sources/simhash";
import { SOURCE_BY_ID } from "@/lib/sources/registry";
import { sanitizeTags } from "@/lib/topics/catalog";
import { SUMMARY_BATCH_SIZE, summarizeBatch, type SummaryInput } from "@/lib/content/summarize";
import type { ContentKind } from "@/lib/sources/types";

/**
 * Enrichment: everything that happens to an article exactly once.
 *
 *   embed      so it can be compared with other articles and with readers
 *   cluster    so five outlets covering one story become one story
 *   extract    so the summary is written from the article, not the headline
 *   summarise  the only step that calls a language model
 *
 * Only the first article in a cluster is summarised. The rest exist to be
 * listed as "also covered by", and paying to summarise them would be paying
 * five times for one story.
 */

/** Cosine similarity at or above which two articles are the same story. */
export const CLUSTER_SIMILARITY = 0.87;
/** How far back a new article looks for a story to join. */
const CLUSTER_WINDOW_HOURS = 96;
/** A later arrival replaces the cluster's summarised article only if clearly better. */
const BETTER_SOURCE_MARGIN = 0.15;
/** Unprocessed items older than this are no longer news. */
const STALE_AFTER_HOURS = 72;

export interface EnrichReport {
  processed: number;
  newClusters: number;
  joined: number;
  summarized: number;
  aiSummaries: number;
  rejected: number;
  expired: number;
  embeddings: boolean;
}

interface NewItem {
  id: string;
  canonical_url: string;
  url: string;
  title: string;
  description: string | null;
  source_id: string | null;
  source_name: string | null;
  kind: ContentKind;
  tags: string[];
  pop_score: number;
  published_at: string | null;
  fetched_at: string;
}

interface RecentItem {
  id: string;
  title: string;
  cluster_id: string | null;
  source_id: string | null;
  summary: string | null;
}

function sourceQuality(sourceId: string | null): number {
  return (sourceId && SOURCE_BY_ID.get(sourceId)?.quality) || 0.5;
}

function embeddingText(item: { title: string; description: string | null }): string {
  return `${item.title}. ${item.description ?? ""}`.trim();
}

/**
 * Process the most promising unprocessed items.
 *
 * Ordered by popularity then recency, so when a run is cut short by a budget
 * or a timeout, what was left undone is the long tail rather than the front
 * page.
 */
export async function enrichBatch(limit = 30): Promise<EnrichReport> {
  const supabase = createAdminClient();

  const report: EnrichReport = {
    processed: 0,
    newClusters: 0,
    joined: 0,
    summarized: 0,
    aiSummaries: 0,
    rejected: 0,
    expired: 0,
    embeddings: false,
  };

  // Anything still unprocessed after three days missed its moment.
  const staleBefore = new Date(Date.now() - STALE_AFTER_HOURS * 3_600_000).toISOString();
  const { data: expired } = await supabase
    .from("content_items")
    .update({ status: "rejected" })
    .eq("status", "new")
    .lt("fetched_at", staleBefore)
    .select("id");
  report.expired = expired?.length ?? 0;

  const { data: rows, error } = await supabase
    .from("content_items")
    .select(
      "id, canonical_url, url, title, description, source_id, source_name, kind, tags, pop_score, published_at, fetched_at"
    )
    .eq("status", "new")
    .order("pop_score", { ascending: false })
    .order("fetched_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load new items: ${error.message}`);

  const items = (rows ?? []) as NewItem[];
  if (items.length === 0) return report;
  report.processed = items.length;

  // -- Embed ---------------------------------------------------------------
  let vectors: number[][] | null = null;
  try {
    vectors = await embedTexts(items.map(embeddingText));
  } catch (err) {
    // An embedding outage must not stall the pipeline: lexical clustering
    // below still works, just less well.
    console.warn("[enrich] embeddings unavailable, using title matching:", err);
  }
  report.embeddings = vectors !== null;

  // -- Cluster -------------------------------------------------------------
  const since = new Date(Date.now() - CLUSTER_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: recentRows } = await supabase
    .from("content_items")
    .select("id, title, cluster_id, source_id, summary")
    .not("cluster_id", "is", null)
    .gte("fetched_at", since)
    .order("fetched_at", { ascending: false })
    // One page. Responses are capped at 1,000 rows, and newest-first means the
    // cap, if it is ever reached, costs matches against the oldest stories.
    .limit(1000);

  // Grows as this batch is processed, so two items in the same batch that are
  // the same story find each other.
  const recent: RecentItem[] = (recentRows ?? []) as RecentItem[];

  const toSummarize: NewItem[] = [];
  const clusterOf = new Map<string, string>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const vector = vectors?.[i] ?? null;
    let clusterId: string | null = null;

    if (vector) {
      // The vector is written first so the similarity search for the *next*
      // item in this batch can see this one.
      await supabase
        .from("content_items")
        .update({ embedding: toVectorLiteral(vector) })
        .eq("id", item.id);

      const { data: matches } = await supabase.rpc("match_recent_items", {
        p_embedding: toVectorLiteral(vector),
        p_since: since,
        p_exclude: item.id,
        p_limit: 3,
      });
      const best = (matches ?? []).find(
        (m: { cluster_id: string | null; similarity: number }) =>
          m.cluster_id && m.similarity >= CLUSTER_SIMILARITY
      );
      if (best) clusterId = best.cluster_id;
    }

    if (!clusterId) {
      const match = recent.find((r) => r.cluster_id && sameStoryByTitle(r.title, item.title));
      if (match) clusterId = match.cluster_id;
    }

    let needsSummary: boolean;

    if (clusterId) {
      report.joined++;
      const members = recent.filter((r) => r.cluster_id === clusterId);
      const bestSummarized = Math.max(
        0,
        ...members.filter((m) => m.summary !== null).map((m) => sourceQuality(m.source_id))
      );
      // Usually false: the story already has its summary. True only when this
      // arrival is from a clearly better source than whatever was summarised,
      // e.g. the project's own post landing after a news rewrite of it.
      needsSummary = sourceQuality(item.source_id) >= bestSummarized + BETTER_SOURCE_MARGIN;

      await supabase.rpc("touch_cluster", { p_cluster_id: clusterId });
    } else {
      const { data: cluster, error: clusterError } = await supabase
        .from("content_clusters")
        .insert({})
        .select("id")
        .single();
      if (clusterError) throw new Error(`Failed to create cluster: ${clusterError.message}`);
      clusterId = cluster.id as string;
      report.newClusters++;
      needsSummary = true;
    }

    clusterOf.set(item.id, clusterId!);
    recent.unshift({
      id: item.id,
      title: item.title,
      cluster_id: clusterId,
      source_id: item.source_id,
      // Marks the slot as taken, so a second arrival in this batch does not
      // also decide it should be the one summarised.
      summary: needsSummary ? "" : null,
    });

    if (needsSummary) {
      toSummarize.push(item);
    } else {
      await supabase
        .from("content_items")
        .update({ cluster_id: clusterId, status: "enriched", enriched_at: new Date().toISOString() })
        .eq("id", item.id);
    }
  }

  // -- Extract -------------------------------------------------------------
  const extracted = await mapLimit(toSummarize, 5, (item) => extractArticle(item.url));
  const bodyOf = new Map(extracted.map((e) => [e.item.id, e.result ?? null]));

  // -- Summarise -----------------------------------------------------------
  for (let i = 0; i < toSummarize.length; i += SUMMARY_BATCH_SIZE) {
    const batch = toSummarize.slice(i, i + SUMMARY_BATCH_SIZE);

    const inputs: SummaryInput[] = batch.map((item) => ({
      id: item.id,
      title: item.title,
      sourceName: item.source_name ?? "",
      text: bodyOf.get(item.id)?.excerpt || item.description || item.title,
      kind: item.kind,
      tags: item.tags,
    }));

    const outputs = await summarizeBatch(inputs);

    for (const output of outputs) {
      const item = batch.find((b) => b.id === output.id)!;
      const rejected = output.quality <= 1 || !output.summary;
      const sourceTopics = (item.source_id && SOURCE_BY_ID.get(item.source_id)?.topics) || [];

      await supabase
        .from("content_items")
        .update({
          cluster_id: clusterOf.get(item.id),
          summary: rejected ? null : output.summary,
          tags: sanitizeTags([...output.tags, ...sourceTopics]),
          kind: output.kind,
          quality: output.quality,
          reading_minutes: bodyOf.get(item.id)?.readingMinutes ?? null,
          summary_model: output.aiGenerated ? "ai" : "fallback",
          status: rejected ? "rejected" : "enriched",
          enriched_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      if (rejected) report.rejected++;
      else report.summarized++;
      if (output.aiGenerated) report.aiSummaries++;
    }
  }

  return report;
}

/** How many items are waiting. Lets the caller decide whether to run again. */
export async function pendingCount(): Promise<number> {
  const supabase = createAdminClient();
  const { count } = await supabase
    .from("content_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "new");
  return count ?? 0;
}
