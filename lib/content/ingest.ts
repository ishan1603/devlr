import { createAdminClient } from "@/lib/supabase-admin";
import { SOURCES, SOURCE_BY_ID } from "@/lib/sources/registry";
import { fetchSource } from "@/lib/sources/fetch";
import { mapLimit } from "@/lib/sources/http";
import {
  mergeByUrl,
  mergePopularity,
  normalizeItem,
  popularityScore,
  type NormalizedItem,
} from "@/lib/content/normalize";
import type { Popularity, SourceDef } from "@/lib/sources/types";

/**
 * Ingestion: sources in, rows in the shared pool out.
 *
 * Only this path talks to the outside world for content. Sends never fetch;
 * they read the pool. That separation is what keeps cost proportional to the
 * number of sources rather than the number of readers.
 */

/** Parallel fetches. Low on purpose: these are other people's servers. */
const FETCH_CONCURRENCY = 6;
/** Sources per Inngest step, sized to finish well inside a function timeout. */
export const INGEST_BATCH_SIZE = 30;

export interface IngestReport {
  sources: number;
  failed: { id: string; error: string }[];
  notModified: number;
  fetched: number;
  inserted: number;
  updated: number;
}

/** Mirror the code registry into the database. Health columns are untouched. */
export async function syncSources(): Promise<number> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("sources").upsert(
    SOURCES.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      url: s.url,
      site_url: s.siteUrl ?? null,
      category: s.category,
      topics: s.topics,
      quality: s.quality,
      is_active: true,
    })),
    { onConflict: "id" }
  );
  if (error) throw new Error(`Failed to sync sources: ${error.message}`);

  // A source removed from the registry stops being fetched but keeps its row,
  // because content_items still references it for attribution.
  const { error: retireError } = await supabase
    .from("sources")
    .update({ is_active: false })
    .not("id", "in", `(${SOURCES.map((s) => `"${s.id}"`).join(",")})`);
  if (retireError) throw new Error(`Failed to retire sources: ${retireError.message}`);

  return SOURCES.length;
}

export function sourceBatches(): string[][] {
  const ids = SOURCES.map((s) => s.id);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += INGEST_BATCH_SIZE) {
    batches.push(ids.slice(i, i + INGEST_BATCH_SIZE));
  }
  return batches;
}

interface ExistingRow {
  id: string;
  canonical_url: string;
  source_id: string | null;
  popularity: Popularity;
  pop_score: number;
  tags: string[];
}

function toRow(item: NormalizedItem) {
  return {
    canonical_url: item.canonical_url,
    url: item.url,
    title: item.title,
    description: item.description,
    source_id: item.source_id,
    source_name: item.source_name,
    site: item.site,
    author: item.author,
    kind: item.kind,
    tags: item.tags,
    popularity: item.popularity,
    pop_score: item.pop_score,
    title_hash: item.title_hash,
    published_at: item.published_at,
    status: "new" as const,
  };
}

/**
 * Fetch a set of sources and store what is new.
 *
 * Safe to re-run: an article already in the pool is never duplicated, it only
 * has its popularity raised if the new sighting carries a higher count.
 */
export async function ingestSources(sourceIds: string[]): Promise<IngestReport> {
  const supabase = createAdminClient();
  const sources = sourceIds.map((id) => SOURCE_BY_ID.get(id)).filter(Boolean) as SourceDef[];

  const report: IngestReport = {
    sources: sources.length,
    failed: [],
    notModified: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
  };
  if (sources.length === 0) return report;

  const { data: states } = await supabase
    .from("sources")
    .select("id, etag, last_modified, error_count")
    .in("id", sourceIds);
  const stateById = new Map((states ?? []).map((s) => [s.id as string, s]));

  const results = await mapLimit(sources, FETCH_CONCURRENCY, (source) => {
    const state = stateById.get(source.id);
    return fetchSource(source, { etag: state?.etag, lastModified: state?.last_modified });
  });

  const now = new Date().toISOString();
  const normalized: NormalizedItem[] = [];

  for (const { item: source, result, error } of results) {
    if (error || !result) {
      report.failed.push({ id: source.id, error: error ?? "no result" });
      await supabase
        .from("sources")
        .update({
          last_fetched_at: now,
          last_error: (error ?? "no result").slice(0, 300),
          error_count: ((stateById.get(source.id)?.error_count as number) ?? 0) + 1,
        })
        .eq("id", source.id);
      continue;
    }

    if (result.notModified) report.notModified++;
    report.fetched += result.items.length;
    for (const raw of result.items) {
      const item = normalizeItem(raw);
      if (item) normalized.push(item);
    }

    await supabase
      .from("sources")
      .update({
        last_fetched_at: now,
        last_success_at: now,
        last_error: null,
        error_count: 0,
        // A 304 carries no validators; keep the ones that produced it.
        ...(result.notModified
          ? {}
          : { etag: result.etag ?? null, last_modified: result.lastModified ?? null }),
      })
      .eq("id", source.id);
  }

  const items = mergeByUrl(normalized);
  if (items.length === 0) return report;

  const { data: existingRows, error: existingError } = await supabase.rpc("existing_items", {
    p_urls: items.map((i) => i.canonical_url),
  });
  if (existingError) throw new Error(`Failed to look up existing items: ${existingError.message}`);

  const existing = new Map(
    ((existingRows ?? []) as ExistingRow[]).map((row) => [row.canonical_url, row])
  );

  const fresh = items.filter((i) => !existing.has(i.canonical_url));
  if (fresh.length > 0) {
    // ignoreDuplicates covers the race where two batches see the same new URL.
    const { data, error } = await supabase
      .from("content_items")
      .upsert(fresh.map(toRow), { onConflict: "canonical_url", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`Failed to store items: ${error.message}`);
    report.inserted = data?.length ?? 0;
  }

  // An article we already hold, seen again with more votes (or seen on HN for
  // the first time): raise its popularity so ranking reflects it.
  for (const item of items) {
    const row = existing.get(item.canonical_url);
    if (!row) continue;
    const popularity = mergePopularity(row.popularity ?? {}, item.popularity);
    const popScore = popularityScore(popularity);
    const tags = [...new Set([...(row.tags ?? []), ...item.tags])];
    if (popScore <= (row.pop_score ?? 0) && tags.length === (row.tags ?? []).length) continue;

    const { error } = await supabase
      .from("content_items")
      .update({ popularity, pop_score: popScore, tags })
      .eq("id", row.id);
    if (!error) report.updated++;
  }

  return report;
}
