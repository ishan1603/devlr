/**
 * Cheap near-duplicate detection on titles.
 *
 * This is the layer between "same URL" and "same meaning". It catches the
 * repost that changed a URL but not the headline, and it runs before any
 * embedding is paid for. It is also the whole duplicate story when embeddings
 * are disabled.
 *
 * Two tools: a 64-bit SimHash for a fast "almost identical" check that can be
 * stored and indexed, and token Jaccard for "the same headline, reworded".
 */

/** Words that carry no identity in a headline. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "as", "how", "why", "what",
  "new", "now", "your", "you", "we", "our", "i", "my", "vs", "via", "into", "about", "after", "over",
  "show", "hn", "ask", "launch", "pdf", "video", "announcing", "introducing", "released", "release",
]);

/**
 * Lowercase, drop site suffixes ("... | TechCrunch", "... - The Verge") and
 * punctuation, keep version numbers intact ("18.2" stays one token).
 */
export function normalizeTitle(title: string): string {
  return title
    // "... | TechCrunch" is always a site name. After a dash it only is when
    // it looks like one (a few capitalised words), because "Postgres 18 - async
    // I/O arrives" is a headline, not a suffix.
    .replace(/\s+\|\s+[^|]{2,40}$/, "")
    .replace(/\s+[\u2013\u2014-]\s+(?:[A-Z][\w.&']*\s?){1,3}$/u, "")
    .toLowerCase()
    .replace(/[\u2018\u2019'`]/g, "")
    .replace(/[^\p{L}\p{N}.+#]+/gu, " ")
    .replace(/(?<!\d)\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleTokens(title: string): string[] {
  return normalizeTitle(title)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * 64-bit SimHash over title tokens and adjacent pairs. Similar titles produce
 * hashes that differ in few bits. Returned as a *signed* 64-bit string because
 * that is what a Postgres `bigint` column holds.
 */
export function titleSimhash(title: string): string | null {
  const tokens = titleTokens(title);
  if (tokens.length === 0) return null;

  const features = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) features.push(`${tokens[i]} ${tokens[i + 1]}`);

  const weights = new Array<number>(64).fill(0);
  for (const feature of features) {
    const hash = fnv1a64(feature);
    for (let bit = 0; bit < 64; bit++) {
      weights[bit] += (hash >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }

  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) out |= 1n << BigInt(bit);
  }
  return BigInt.asIntN(64, out).toString();
}

/** Number of differing bits between two SimHash strings. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt.asUintN(64, BigInt(a)) ^ BigInt.asUintN(64, BigInt(b));
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / (setA.size + setB.size - shared);
}

/** SimHash distance at or under which two titles are treated as one story. */
export const SIMHASH_MAX_DISTANCE = 6;
/** Token overlap at or over which two titles are treated as one story. */
export const TITLE_JACCARD_THRESHOLD = 0.6;

/**
 * Do these two headlines describe the same story?
 *
 * Short titles need care: "Go 1.26" and "Go 1.25" share one of two tokens and
 * differ in exactly the part that matters. So very short titles must match
 * outright, and version numbers must not disagree.
 */
export function sameStoryByTitle(a: string, b: string): boolean {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const versionsA = tokensA.filter((t) => /^\d+(\.\d+)+$/.test(t) || /^v?\d+\.\d+/.test(t));
  const versionsB = tokensB.filter((t) => /^\d+(\.\d+)+$/.test(t) || /^v?\d+\.\d+/.test(t));
  if (versionsA.length && versionsB.length && !versionsA.some((v) => versionsB.includes(v))) {
    return false;
  }

  if (Math.min(tokensA.length, tokensB.length) < 4) {
    return tokensA.join(" ") === tokensB.join(" ");
  }

  if (jaccard(tokensA, tokensB) >= TITLE_JACCARD_THRESHOLD) return true;

  const hashA = titleSimhash(a);
  const hashB = titleSimhash(b);
  return Boolean(hashA && hashB && hammingDistance(hashA, hashB) <= SIMHASH_MAX_DISTANCE);
}
