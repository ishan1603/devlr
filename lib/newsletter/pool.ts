import { createAdminClient } from "@/lib/supabase-admin";
import { fetchArticles, type Article } from "@/lib/news";

/** An article as it lives in the shared pool, carrying its row id. */
export interface PoolArticle extends Article {
  id: string;
}

/** How far back an article stays eligible for inclusion in a digest. */
const FRESHNESS_DAYS = 7;
/** How far back to look when deciding a user has already seen a story. */
const SEEN_WINDOW_DAYS = 90;
/** Articles per category in a single issue. */
const PER_CATEGORY = 5;
/**
 * Minimum gap between on-demand ingests of the same category.
 *
 * Assembly may ingest when the pool has nothing unseen, but that runs inside a
 * *send*. Without this floor, N users hitting an exhausted pool would trigger N
 * fetches and recreate the per-user fan-out the pool exists to prevent. If the
 * category was refreshed this recently, an empty result is the truth: there is
 * genuinely nothing new, and the hourly cron will bring more.
 */
const ON_DEMAND_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * Fetch each category once and upsert into the shared pool.
 *
 * Called by the ingestion cron, never by a send. `ignoreDuplicates` on the
 * (url, category) key means re-running is cheap and non-destructive: an article
 * already in the pool keeps its original fetched_at rather than looking newer
 * than it is.
 */
export async function ingestCategories(categories: string[]) {
  if (categories.length === 0) return { categories: [], fetched: 0, stored: 0 };

  const supabase = createAdminClient();
  const fetched = await fetchArticles(categories);

  if (fetched.length === 0) return { categories, fetched: 0, stored: 0 };

  const rows = fetched.map((a) => ({
    url: a.url,
    category: a.category,
    title: a.title,
    description: a.description,
    source: a.source ?? null,
    published_at: a.publishedAt ?? null,
  }));

  const { data, error } = await supabase
    .from("articles")
    .upsert(rows, { onConflict: "url,category", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`Failed to store articles: ${error.message}`);

  return { categories, fetched: fetched.length, stored: data?.length ?? 0 };
}

function toPoolArticle(r: any): PoolArticle {
  return {
    id: r.id as string,
    url: r.url as string,
    title: r.title as string,
    description: (r.description ?? "") as string,
    category: r.category as string,
    source: (r.source ?? undefined) as string | undefined,
    publishedAt: (r.published_at ?? undefined) as string | undefined,
  };
}

/** Most recent fetch time for a category, or null if the pool never held it. */
async function lastFetchedAt(category: string): Promise<Date | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("articles")
    .select("fetched_at")
    .eq("category", category)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.fetched_at ? new Date(data.fetched_at as string) : null;
}

/**
 * Build one issue for one user out of the shared pool.
 *
 * Deduplication is by **URL**, not by article row. `articles` is keyed
 * (url, category), so a story filed under both technology and business exists
 * twice with different ids; keying on the id would let the same link appear in
 * two sections of the same issue, and again next week.
 *
 * If a category has nothing usable (cold start, or ingestion failing), it falls
 * back to a direct fetch so the reader still gets a newsletter — subject to the
 * cooldown above.
 */
export async function assembleForUser(
  userId: string,
  categories: string[]
): Promise<{ articles: PoolArticle[]; usedFallback: string[]; skipped: string[] }> {
  const supabase = createAdminClient();

  const freshSince = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000).toISOString();
  const seenSince = new Date(Date.now() - SEEN_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: seenRows, error: seenError } = await supabase
    .from("newsletter_send_articles")
    .select("article_url")
    .eq("user_id", userId)
    .gte("created_at", seenSince);

  if (seenError) throw new Error(`Failed to load seen articles: ${seenError.message}`);

  // Seeded from history, then added to as this issue is built — which is what
  // stops one story appearing under two of the reader's categories at once.
  const seen = new Set<string>(
    (seenRows ?? []).map((r) => r.article_url as string).filter(Boolean)
  );

  const selected: PoolArticle[] = [];
  const usedFallback: string[] = [];
  // Categories left out because the pool was exhausted but too fresh to refetch.
  const skipped: string[] = [];

  for (const category of categories) {
    const readPool = async () => {
      const { data, error } = await supabase
        .from("articles")
        .select("id, url, title, description, category, source, published_at")
        .eq("category", category)
        .gte("fetched_at", freshSince)
        .order("published_at", { ascending: false, nullsFirst: false })
        // Over-fetch, because many of these will already have been seen.
        .limit(PER_CATEGORY * 6);

      if (error) throw new Error(`Failed to read pool for ${category}: ${error.message}`);

      const picked: PoolArticle[] = [];
      for (const row of data ?? []) {
        if (picked.length >= PER_CATEGORY) break;
        if (seen.has(row.url as string)) continue;
        seen.add(row.url as string);
        picked.push(toPoolArticle(row));
      }
      return picked;
    };

    const unseen = await readPool();
    if (unseen.length > 0) {
      selected.push(...unseen);
      continue;
    }

    const fetchedAt = await lastFetchedAt(category);
    if (fetchedAt && Date.now() - fetchedAt.getTime() < ON_DEMAND_COOLDOWN_MS) {
      skipped.push(category);
      continue;
    }

    usedFallback.push(category);
    await ingestCategories([category]);
    selected.push(...(await readPool()));
  }

  return { articles: selected, usedFallback, skipped };
}

/**
 * Record which stories went into a send.
 *
 * `article_url` is stored alongside the id on purpose: the id's foreign key is
 * ON DELETE SET NULL, so pruning the pool nulls the reference but the memory of
 * having sent that URL survives. Under the previous CASCADE, deleting an old
 * article erased the evidence and the story could be sent again.
 */
export async function recordSentArticles(
  sendId: string,
  userId: string,
  articles: PoolArticle[]
) {
  if (articles.length === 0) return;
  const supabase = createAdminClient();

  const { error } = await supabase.from("newsletter_send_articles").upsert(
    articles.map((a) => ({
      send_id: sendId,
      article_id: a.id,
      article_url: a.url,
      user_id: userId,
    })),
    { onConflict: "send_id,article_url", ignoreDuplicates: true }
  );

  if (error) throw new Error(`Failed to record sent articles: ${error.message}`);
}

/** Distinct categories any active subscriber actually wants — the ingest set. */
export async function activeCategories(): Promise<string[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("user_preferences")
    .select("categories")
    .eq("is_active", true);

  if (error) throw new Error(`Failed to load active categories: ${error.message}`);

  const set = new Set<string>();
  for (const row of data ?? []) for (const c of row.categories ?? []) set.add(c);
  return [...set].sort();
}
