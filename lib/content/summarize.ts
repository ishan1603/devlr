import { z } from "zod";
import { completeJSON } from "@/lib/ai/router";
import { VOICE, cleanProse, describeIssues, lintProse } from "@/lib/ai/style";
import { ALL_TAGS, sanitizeTags } from "@/lib/topics/catalog";
import type { ContentKind } from "@/lib/sources/types";

/**
 * One summary per article, written once, shared by every reader who gets it.
 *
 * This is where the model earns its place: reading the extracted text and
 * saying in one or two plain sentences what happened and why a developer would
 * care. It also classifies, because it is already reading the article and a
 * second call would cost a second request.
 */

export interface SummaryInput {
  id: string;
  title: string;
  sourceName: string;
  /** Extracted body if available, otherwise the feed's own description. */
  text: string;
  kind: ContentKind;
  tags: string[];
}

export interface SummaryOutput {
  id: string;
  summary: string;
  tags: string[];
  kind: ContentKind;
  /** 1 to 5. Anything at 1 is rejected from the pool. */
  quality: number;
  /** False when the model was unavailable and the description was used. */
  aiGenerated: boolean;
}

/** Articles per request. Sized to stay under Groq's 8K tokens-per-minute cap. */
export const SUMMARY_BATCH_SIZE = 5;
const MAX_INPUT_CHARS = 1800;
const MAX_SUMMARY_CHARS = 320;

const KINDS = ["news", "blog", "tutorial", "release", "paper", "discussion", "repo"] as const;

const ResponseSchema = z.object({
  items: z.array(
    z.object({
      n: z.number().int(),
      summary: z.string(),
      tags: z.array(z.string()),
      kind: z.enum(KINDS),
      quality: z.number().int().min(1).max(5),
    })
  ),
});

const SYSTEM = [
  VOICE,
  "",
  "You are given numbered articles. For each one, return:",
  "- summary: one or two sentences, 45 words at most. Say what happened or what the piece",
  "  shows, then why it matters to someone who builds software. Use only facts present in the",
  "  supplied text. Do not start with 'This article', 'The author' or the article's title.",
  "  Do not address the reader as 'you'. Plain text, no markup.",
  "- tags: up to 5 tags, chosen ONLY from this list: " + ALL_TAGS.join(", ") + ".",
  "- kind: news (press coverage of an event), release (a version or product shipping),",
  "  blog (analysis or an engineering write-up), tutorial (how-to), paper (research),",
  "  repo (a code repository), discussion.",
  "- quality: 5 original and technically substantive; 4 solid and useful; 3 ordinary news or",
  "  an announcement; 2 thin, promotional or barely relevant to developers; 1 spam, pure",
  "  marketing, or nothing to do with software.",
  "Return every article you were given, using its number as n.",
].join("\n");

/** First sentence or two of a description, as a non-AI stand-in for a summary. */
export function fallbackSummary(text: string): string {
  const cleaned = cleanProse(text);
  if (!cleaned) return "";
  const sentences = cleaned.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [cleaned];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).length > MAX_SUMMARY_CHARS) break;
    out += sentence;
    if (out.length > 140) break;
  }
  out = (out || cleaned.slice(0, MAX_SUMMARY_CHARS)).trim();
  return out.replace(/!+/g, ".");
}

function fallback(input: SummaryInput): SummaryOutput {
  return {
    id: input.id,
    summary: fallbackSummary(input.text),
    tags: input.tags,
    kind: input.kind,
    quality: 3,
    aiGenerated: false,
  };
}

/**
 * Summarise up to SUMMARY_BATCH_SIZE articles in one request.
 *
 * Every input gets an output. If the model is unavailable, omits an article, or
 * writes something that fails the style guard, that article falls back to its
 * own description rather than leaving a gap or shipping a banned phrase.
 */
export async function summarizeBatch(inputs: SummaryInput[]): Promise<SummaryOutput[]> {
  if (inputs.length === 0) return [];

  const block = (input: SummaryInput, n: number) =>
    `### ${n}\nTITLE: ${input.title}\nSOURCE: ${input.sourceName}\nTEXT: ${input.text.slice(0, MAX_INPUT_CHARS)}`;

  const first = await completeJSON({
    task: "summarize",
    system: SYSTEM,
    prompt: inputs.map((input, i) => block(input, i + 1)).join("\n\n"),
    schema: ResponseSchema,
    temperature: 0.3,
    maxTokens: 1400,
    version: "summarize-v2",
  });

  const answers = new Map((first?.data.items ?? []).map((item) => [item.n, item]));
  const review = (n: number) => {
    const answer = answers.get(n);
    if (!answer) return null;
    const summary = cleanProse(answer.summary).slice(0, MAX_SUMMARY_CHARS + 80);
    return { answer, summary, issues: summary ? lintProse(summary) : [{ rule: "empty" as const, detail: "" }] };
  };

  // One rewrite for whatever failed the style guard, with the reason. Only the
  // failures are resent, so a clean batch costs nothing extra.
  const failing = inputs
    .map((_, i) => i + 1)
    .filter((n) => (review(n)?.issues.length ?? 0) > 0);

  if (failing.length > 0) {
    const notes = failing
      .map((n) => `### ${n}: ${describeIssues(review(n)!.issues)}\nYour summary was: ${review(n)!.summary}`)
      .join("\n");

    const second = await completeJSON({
      task: "summarize",
      system: SYSTEM,
      prompt:
        failing.map((n) => block(inputs[n - 1], n)).join("\n\n") +
        `\n\nYou summarised these before and the summaries broke the style rules. Rewrite them.\n${notes}`,
      schema: ResponseSchema,
      temperature: 0.3,
      maxTokens: 1000,
      version: "summarize-v2",
      cache: false,
    });
    for (const item of second?.data.items ?? []) {
      if (failing.includes(item.n)) answers.set(item.n, item);
    }
  }

  return inputs.map((input, i) => {
    const reviewed = review(i + 1);
    if (!reviewed) return fallback(input);

    const { answer, summary, issues } = reviewed;
    if (issues.length > 0) {
      // Still not clean. Keep the classification, which is useful regardless,
      // and use the article's own description for the prose.
      return {
        ...fallback(input),
        tags: mergeTags(input.tags, answer.tags),
        kind: answer.kind,
        quality: answer.quality,
      };
    }

    return {
      id: input.id,
      summary,
      tags: mergeTags(input.tags, answer.tags),
      kind: answer.kind,
      quality: answer.quality,
      aiGenerated: true,
    };
  });
}

/**
 * The model's tags are trusted when it gave any, since it read the article and
 * the keyword tagger only matched strings. Unknown tags are discarded.
 */
function mergeTags(existing: string[], fromModel: string[]): string[] {
  const model = sanitizeTags(fromModel);
  return model.length > 0 ? model.slice(0, 6) : existing;
}
