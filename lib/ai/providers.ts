/**
 * Every provider here speaks the OpenAI chat-completions dialect, so one
 * client covers all of them and switching is a base URL.
 *
 * All of these are permanent free tiers. The limits below are deliberately set
 * under the published ceilings: the point of tracking a budget is to stop on
 * our own terms rather than be cut off mid-run by a 429.
 *
 * Model pins go stale without warning (Groq dropped every Llama model from its
 * free tier in 2026). A dead pin surfaces as a 404, which the router logs
 * loudly and routes around. `npm run ai:check` lists what each key can reach.
 */

export type Task =
  /** Bulk, cheap, high volume: per-article summaries and classification. */
  | "summarize"
  /** Per-user writing: subject line, intro. Quality matters, volume is low. */
  | "editor"
  /** Long-form generation for Learn. */
  | "author"
  /** Critique of another model's work. Routed to a different model family. */
  | "reviewer"
  /** Yes/no relevance calls. */
  | "judge";

export interface ModelSpec {
  /** Stable id used in usage tracking: `<provider>:<model>`. */
  id: string;
  provider: "groq" | "gemini" | "cerebras" | "openrouter";
  model: string;
  baseURL: string;
  apiKeyEnv: string;
  /** Daily ceilings we hold ourselves to. */
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  /** Extra body params this model needs (reasoning controls differ by vendor). */
  extra?: Record<string, unknown>;
}

const GROQ = "https://api.groq.com/openai/v1";

// Groq free tier, per model: 30 RPM, 1K RPD, 8K TPM, 200K TPD.
const groq = (model: string, extra?: Record<string, unknown>): ModelSpec => ({
  id: `groq:${model}`,
  provider: "groq",
  model,
  baseURL: GROQ,
  apiKeyEnv: "GROQ_API_KEY",
  maxRequestsPerDay: 900,
  maxTokensPerDay: 180_000,
  extra,
});

export const MODELS = {
  // gpt-oss models reason before answering, and reasoning tokens are billed
  // against the same 200K/day. "low" keeps most of the budget for output.
  groqLarge: groq(process.env.GROQ_MODEL_LARGE ?? "openai/gpt-oss-120b", { reasoning_effort: "low" }),
  groqSmall: groq(process.env.GROQ_MODEL_SMALL ?? "openai/gpt-oss-20b", { reasoning_effort: "low" }),
  groqAlt: groq(process.env.GROQ_MODEL_ALT ?? "qwen/qwen3.8-27b"),

  // The `-latest` alias tracks whatever Flash-Lite Google currently serves, so
  // this one does not go stale. Free tier: several hundred requests a day with
  // a large per-minute token allowance, which makes it the bulk workhorse.
  geminiLite: {
    id: "gemini:flash-lite",
    provider: "gemini",
    model: process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    maxRequestsPerDay: 450,
    maxTokensPerDay: 2_000_000,
  } satisfies ModelSpec,

  geminiPro: {
    id: "gemini:pro",
    provider: "gemini",
    model: process.env.GEMINI_PRO_MODEL ?? "gemini-1.5-pro-latest",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    maxRequestsPerDay: 1500,
    maxTokensPerDay: 4_000_000,
  } satisfies ModelSpec,

  cerebras: {
    id: "cerebras:default",
    provider: "cerebras",
    model: process.env.CEREBRAS_MODEL ?? "gpt-oss-120b",
    baseURL: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    maxRequestsPerDay: 900,
    maxTokensPerDay: 800_000,
  } satisfies ModelSpec,

  openrouter: {
    id: "openrouter:free",
    provider: "openrouter",
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-oss-20b:free",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxRequestsPerDay: 45,
    maxTokensPerDay: 200_000,
  } satisfies ModelSpec,
} as const;

/**
 * Fallback order per task.
 *
 * Bulk work goes to Gemini first because its free tier is measured in requests
 * with generous tokens, while Groq's is tight on tokens. Writing goes to the
 * largest Groq model first. The reviewer deliberately starts on a different
 * family from the author, so one model's blind spots are not also the
 * reviewer's.
 */
export const ROUTES: Record<Task, ModelSpec[]> = {
  summarize: [MODELS.geminiLite, MODELS.geminiPro, MODELS.groqSmall, MODELS.groqAlt, MODELS.cerebras, MODELS.openrouter],
  editor: [MODELS.geminiPro, MODELS.groqLarge, MODELS.groqAlt, MODELS.geminiLite, MODELS.groqSmall, MODELS.cerebras],
  author: [MODELS.geminiPro, MODELS.groqLarge, MODELS.cerebras, MODELS.geminiLite, MODELS.groqAlt],
  reviewer: [MODELS.geminiPro, MODELS.geminiLite, MODELS.groqAlt, MODELS.groqSmall, MODELS.cerebras],
  judge: [MODELS.geminiPro, MODELS.groqSmall, MODELS.geminiLite, MODELS.groqAlt, MODELS.openrouter],
};

/** Models whose API key is actually present in this environment. */
export function availableModels(task: Task): ModelSpec[] {
  return ROUTES[task].filter((m) => Boolean(process.env[m.apiKeyEnv]));
}

export function hasAnyProvider(): boolean {
  return Object.values(MODELS).some((m) => Boolean(process.env[m.apiKeyEnv]));
}
