/**
 * Text embeddings, via Gemini's free tier.
 *
 * Used for two things: deciding that two articles are the same story, and
 * scoring how close an article is to what a reader cares about. Both compare
 * like with like, so one task type covers both.
 *
 * Embeddings are optional. With no GEMINI_API_KEY every function here returns
 * null, and callers fall back to lexical matching (title shingles for
 * duplicates, tags for relevance). Worse, but never broken.
 */

export const EMBEDDING_DIMENSIONS = 768;

const MODEL = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;
/** Gemini accepts up to 100 texts per batch request. */
const BATCH_SIZE = 100;
/** Titles plus a paragraph carry the meaning; more only costs quota. */
const MAX_CHARS = 2000;

export function embeddingsEnabled(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY!,
    },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text: text.slice(0, MAX_CHARS) || " " }] },
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as { embeddings?: { values: number[] }[] };
  const vectors = (body.embeddings ?? []).map((e) => e.values);
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding count mismatch: sent ${texts.length}, got ${vectors.length}`);
  }
  return vectors;
}

/**
 * Embed many texts. Returns null (not an empty array) when embeddings are
 * unavailable, so a caller cannot mistake "disabled" for "no results".
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!embeddingsEnabled()) return null;
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

export async function embedText(text: string): Promise<number[] | null> {
  const result = await embedTexts([text]);
  return result?.[0] ?? null;
}

/** pgvector's text form. PostgREST passes this through to a `halfvec` column. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => Number(v.toFixed(6))).join(",")}]`;
}

/** Parse what PostgREST returns for a vector column. */
export function fromVectorLiteral(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string" || value.length < 2) return null;
  try {
    return JSON.parse(value) as number[];
  } catch {
    return null;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
