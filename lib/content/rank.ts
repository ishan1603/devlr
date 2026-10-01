import { titleTokens, jaccard } from "@/lib/sources/simhash";
import type { ContentKind, Popularity } from "@/lib/sources/types";

/**
 * Ranking: which of a few hundred candidate articles go into one reader's
 * issue, and in what order.
 *
 * Pure functions over plain data. No database, no clock other than the one
 * passed in, so the behaviour that decides what people read is pinned by tests.
 */

export interface Candidate {
  id: string;
  clusterId: string | null;
  canonicalUrl: string;
  url: string;
  title: string;
  summary: string;
  sourceId: string | null;
  sourceName: string;
  site: string;
  kind: ContentKind;
  tags: string[];
  popularity: Popularity;
  popScore: number;
  /** The summariser's 1 to 5 judgement, if it ran. */
  quality: number | null;
  /** Prior trust in the source, 0 to 1. */
  sourceQuality: number;
  readingMinutes: number | null;
  publishedAt: string;
  /** Cosine similarity to the reader's interest vector, when embeddings exist. */
  similarity: number | null;
}

export interface RankContext {
  /** Stack items the reader picked. A hit here is the strongest signal. */
  stack: string[];
  /** Broad domains the reader picked. */
  domains: string[];
  /**
   * Learned preferences from "more like this" and "less like this", keyed
   * `tag:react`, `site:example.com`, `source:rss:foo`. Positive or negative.
   */
  affinity: Map<string, number>;
  now: Date;
  /** How many days this issue covers. Sets how fast an article ages. */
  windowDays: number;
}

export interface Scored extends Candidate {
  score: number;
  relevance: number;
}

const WEIGHTS = {
  relevance: 0.4,
  popularity: 0.2,
  recency: 0.15,
  quality: 0.15,
  source: 0.1,
};

/** Similarity below this is noise; at or above the upper bound is a clear match. */
const SIMILARITY_FLOOR = 0.55;
const SIMILARITY_CEILING = 0.8;

/**
 * How much this article is about what the reader does.
 *
 * Tags and embeddings fail in different ways. Tags are precise but blind to
 * anything the keyword list does not know; embeddings generalise but drift. A
 * stack hit is taken at face value, and the vector is used to rescue relevant
 * articles the tagger missed and to order articles that tie on tags.
 */
export function relevance(candidate: Candidate, ctx: RankContext): number {
  const tags = new Set(candidate.tags);
  const stackHits = ctx.stack.filter((t) => tags.has(t)).length;
  const domainHits = ctx.domains.filter((t) => tags.has(t)).length;

  let tagScore = 0;
  if (stackHits > 0) tagScore = Math.min(1, 0.85 + 0.075 * (stackHits - 1));
  else if (domainHits > 0) tagScore = Math.min(0.7, 0.55 + 0.075 * (domainHits - 1));

  if (candidate.similarity === null) return tagScore;

  const simScore = Math.max(
    0,
    Math.min(1, (candidate.similarity - SIMILARITY_FLOOR) / (SIMILARITY_CEILING - SIMILARITY_FLOOR))
  );

  // With a tag match the vector can only add: it closes up to half of the gap
  // to 1, and a weak vector never drags a direct match down. Without a tag
  // match the vector has to carry the article alone and is capped below what a
  // stack match scores.
  if (tagScore > 0) return tagScore + (1 - tagScore) * 0.5 * simScore;
  return 0.75 * simScore;
}

/** 1 at publication, 0.5 after half the window, never quite 0. */
export function recency(publishedAt: string, ctx: RankContext): number {
  const ageHours = Math.max(0, (ctx.now.getTime() - Date.parse(publishedAt)) / 3_600_000);
  const halfLifeHours = Math.max(12, (ctx.windowDays * 24) / 2);
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/** Net learned preference for this article, clamped to [-1, 1]. */
export function affinityFor(candidate: Candidate, affinity: Map<string, number>): number {
  if (affinity.size === 0) return 0;
  let total = 0;
  for (const tag of candidate.tags) total += affinity.get(`tag:${tag}`) ?? 0;
  total += affinity.get(`site:${candidate.site}`) ?? 0;
  if (candidate.sourceId) total += affinity.get(`source:${candidate.sourceId}`) ?? 0;
  return Math.max(-1, Math.min(1, total));
}

export function scoreCandidate(candidate: Candidate, ctx: RankContext): Scored {
  const rel = relevance(candidate, ctx);
  const quality = candidate.quality === null ? 0.5 : (candidate.quality - 1) / 4;

  const base =
    WEIGHTS.relevance * rel +
    WEIGHTS.popularity * candidate.popScore +
    WEIGHTS.recency * recency(candidate.publishedAt, ctx) +
    WEIGHTS.quality * quality +
    WEIGHTS.source * candidate.sourceQuality;

  // Feedback scales the score rather than adding to it, so a reader's "less
  // like this" can sink a popular article but cannot rescue an irrelevant one.
  const score = base * (1 + 0.35 * affinityFor(candidate, ctx.affinity));

  return { ...candidate, score, relevance: rel };
}

/**
 * How alike two articles are, for diversity. Deliberately lexical: it runs on
 * every pair, and embeddings for a few hundred candidates would be megabytes
 * of JSON for a decision that tags and titles make well enough.
 */
export function overlap(a: Candidate, b: Candidate): number {
  if (a.clusterId && a.clusterId === b.clusterId) return 1;
  const tagOverlap = jaccard(a.tags, b.tags);
  const titleOverlap = jaccard(titleTokens(a.title), titleTokens(b.title));
  const sameSite = a.site && a.site === b.site ? 0.15 : 0;
  return Math.min(1, 0.45 * tagOverlap + 0.7 * titleOverlap + sameSite);
}

export interface SelectOptions {
  count: number;
  /** 1 means pure score order, lower trades score for variety. */
  lambda?: number;
  /** No more than this many articles from one site in an issue. */
  maxPerSite?: number;
  /** Articles with relevance below this are never selected. */
  minRelevance?: number;
}

/**
 * Pick the issue.
 *
 * One article per story (cluster), then maximal marginal relevance: each pick
 * is the best remaining article after subtracting how much it repeats what is
 * already chosen. Without this, the week Postgres ships a release, a Postgres
 * user's issue would be eight articles about that release.
 */
export function selectDiverse(candidates: Scored[], options: SelectOptions): Scored[] {
  const lambda = options.lambda ?? 0.72;
  const maxPerSite = options.maxPerSite ?? 2;
  const minRelevance = options.minRelevance ?? 0.2;

  // Best article per cluster.
  const byCluster = new Map<string, Scored>();
  for (const c of candidates) {
    if (c.relevance < minRelevance) continue;
    const key = c.clusterId ?? c.canonicalUrl;
    const current = byCluster.get(key);
    if (!current || c.score > current.score) byCluster.set(key, c);
  }

  const pool = [...byCluster.values()].sort((a, b) => b.score - a.score);
  const selected: Scored[] = [];
  const perSite = new Map<string, number>();

  while (selected.length < options.count && pool.length > 0) {
    let bestIndex = -1;
    let bestValue = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      if ((perSite.get(candidate.site) ?? 0) >= maxPerSite) continue;

      let maxOverlap = 0;
      for (const chosen of selected) {
        maxOverlap = Math.max(maxOverlap, overlap(candidate, chosen));
        if (maxOverlap >= 1) break;
      }

      const value = lambda * candidate.score - (1 - lambda) * maxOverlap;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) break;
    const [picked] = pool.splice(bestIndex, 1);
    selected.push(picked);
    perSite.set(picked.site, (perSite.get(picked.site) ?? 0) + 1);
  }

  return selected;
}

/**
 * Turn feedback rows into the affinity map.
 *
 * Each vote spreads across the tags it carried, so one "less like this" on an
 * article tagged with five things nudges each a little rather than condemning
 * all five. Votes fade over about three months: taste changes, and an old
 * dislike should not be permanent.
 */
export function buildAffinity(
  feedback: { signal: number; tags: string[]; site: string | null; source_id: string | null; created_at: string }[],
  now: Date
): Map<string, number> {
  const affinity = new Map<string, number>();
  const bump = (key: string, amount: number) => affinity.set(key, (affinity.get(key) ?? 0) + amount);

  for (const row of feedback) {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(row.created_at)) / 86_400_000);
    const weight = row.signal * Math.pow(0.5, ageDays / 90);

    const tags = row.tags ?? [];
    for (const tag of tags) bump(`tag:${tag}`, (0.5 * weight) / Math.max(1, tags.length));
    if (row.site) bump(`site:${row.site}`, 0.3 * weight);
    if (row.source_id) bump(`source:${row.source_id}`, 0.2 * weight);
  }

  return affinity;
}
