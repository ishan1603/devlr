import { createHash } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase-admin";
import { availableModels, type ModelSpec, type Task } from "@/lib/ai/providers";

/**
 * The one way model calls leave this codebase.
 *
 * Three jobs, all in service of running on free tiers:
 *
 *   Fallback   each task has an ordered list of models; a 429, a dead pin or a
 *              malformed answer moves on to the next rather than failing.
 *   Budget     requests and tokens are counted per model per day in Postgres,
 *              and a model is skipped before it hits the provider's ceiling.
 *   Replay     every answer is cached by prompt hash. Inngest re-runs a step
 *              from the top when it retries, so without this a flaky send would
 *              pay for the same completions again.
 *
 * It returns null instead of throwing when nothing could answer. Every caller
 * has a deterministic fallback, and "the model is unavailable" must never be
 * the reason an email does not go out.
 */

export interface CompleteParams<T> {
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxTokens?: number;
  /** Bump to invalidate cached answers when a prompt's meaning changes. */
  version?: string;
  /** Set false for calls that must be fresh, e.g. a rewrite after a lint failure. */
  cache?: boolean;
}

export interface CompleteResult<T> {
  data: T;
  model: string;
  cached: boolean;
  tokens: number;
}

// ---------------------------------------------------------------------------
// Database access, optional by design
// ---------------------------------------------------------------------------
// Tests and local scripts run without a service-role key. The router still
// works there, it just has no cache and no budget.

function db() {
  try {
    return createAdminClient();
  } catch {
    return null;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cacheKey(params: CompleteParams<unknown>): string {
  return createHash("sha256")
    .update([params.version ?? "v1", params.task, params.system, params.prompt].join("\u0000"))
    .digest("hex");
}

async function readCache(key: string): Promise<unknown | null> {
  const supabase = db();
  if (!supabase) return null;
  const { data } = await supabase.from("llm_cache").select("output").eq("key", key).maybeSingle();
  return data?.output ?? null;
}

async function writeCache(key: string, task: Task, model: ModelSpec, output: unknown, tokens: number) {
  const supabase = db();
  if (!supabase) return;
  await supabase
    .from("llm_cache")
    .upsert({ key, task, provider: model.provider, model: model.model, output, tokens });
}

// Budget rows are read at most once a minute per model. Being a few requests
// stale is fine: the ceilings already sit below the real limits.
const budgetCache = new Map<string, { at: number; requests: number; tokens: number }>();

async function withinBudget(model: ModelSpec): Promise<boolean> {
  const cached = budgetCache.get(model.id);
  let usage = cached && Date.now() - cached.at < 60_000 ? cached : null;

  if (!usage) {
    const supabase = db();
    if (!supabase) return true;
    const { data } = await supabase
      .from("provider_usage")
      .select("requests, tokens")
      .eq("provider", model.provider)
      .eq("model", model.model)
      .eq("day", today())
      .maybeSingle();
    usage = { at: Date.now(), requests: data?.requests ?? 0, tokens: data?.tokens ?? 0 };
    budgetCache.set(model.id, usage);
  }

  return usage.requests < model.maxRequestsPerDay && usage.tokens < model.maxTokensPerDay;
}

async function recordUsage(model: ModelSpec, tokens: number) {
  const cached = budgetCache.get(model.id);
  if (cached) {
    cached.requests += 1;
    cached.tokens += tokens;
  }
  const supabase = db();
  if (!supabase) return;
  await supabase.rpc("bump_provider_usage", {
    p_provider: model.provider,
    p_model: model.model,
    p_day: today(),
    p_requests: 1,
    p_tokens: tokens,
  });
}

// ---------------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------------
// In-memory on purpose. A serverless instance that forgets a cooldown simply
// rediscovers it with one failed request, and the daily budget above is the
// durable guard.

const coolingUntil = new Map<string, number>();

function coolDown(model: ModelSpec, ms: number, why: string) {
  coolingUntil.set(model.id, Date.now() + ms);
  console.warn(`[ai] ${model.id} cooling for ${Math.round(ms / 1000)}s: ${why}`);
}

function msUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

function handleFailure(model: ModelSpec, err: unknown) {
  if (err instanceof OpenAI.APIError) {
    const message = String(err.message ?? "");
    if (err.status === 404) {
      // The single most confusing failure this project has had: a retired model
      // id that degrades output silently. Say so in words.
      console.error(
        `[ai] MODEL PIN IS DEAD: ${model.id} returned 404. Update the pin in lib/ai/providers.ts ` +
          `or set the matching *_MODEL env var. Run "npm run ai:check" to see what is available.`
      );
      return coolDown(model, 6 * 3_600_000, "model not found");
    }
    if (err.status === 401 || err.status === 403) {
      return coolDown(model, 6 * 3_600_000, `auth rejected (${err.status})`);
    }
    if (err.status === 429) {
      if (/per day|\bTPD\b|\bRPD\b|daily/i.test(message)) {
        return coolDown(model, msUntilUtcMidnight(), "daily limit reached");
      }
      const retryAfter = Number(err.headers?.get?.("retry-after"));
      return coolDown(
        model,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000,
        "rate limited"
      );
    }
    return coolDown(model, 30_000, `HTTP ${err.status ?? "?"}: ${message.slice(0, 120)}`);
  }
  coolDown(model, 30_000, err instanceof Error ? err.message.slice(0, 120) : "unknown error");
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

const clients = new Map<string, OpenAI>();

function clientFor(model: ModelSpec): OpenAI {
  let client = clients.get(model.baseURL);
  if (!client) {
    client = new OpenAI({
      apiKey: process.env[model.apiKeyEnv],
      baseURL: model.baseURL,
      // Fallback is this module's job. SDK-level retries would spend the
      // per-minute token allowance on a model we are about to route around.
      maxRetries: 0,
      timeout: 45_000,
    });
    clients.set(model.baseURL, client);
  }
  return client;
}

/**
 * Pull a JSON object out of a completion.
 *
 * JSON mode is requested, but reasoning models sometimes prepend a
 * `<think>` block and some providers wrap the object in a code fence.
 */
export function extractJSON(raw: string): unknown {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in completion");
  return JSON.parse(text.slice(start, end + 1));
}

async function callOnce(
  model: ModelSpec,
  messages: OpenAI.ChatCompletionMessageParam[],
  params: CompleteParams<unknown>
): Promise<{ text: string; tokens: number }> {
  const completion = await clientFor(model).chat.completions.create({
    model: model.model,
    messages,
    temperature: params.temperature ?? 0.4,
    max_completion_tokens: params.maxTokens ?? 1500,
    ...(model.extra as object),
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);

  return {
    text: completion.choices[0]?.message?.content ?? "",
    tokens: completion.usage?.total_tokens ?? 0,
  };
}

export async function completeJSON<T>(params: CompleteParams<T>): Promise<CompleteResult<T> | null> {
  const key = cacheKey(params);

  if (params.cache !== false) {
    const hit = await readCache(key);
    if (hit !== null) {
      const parsed = params.schema.safeParse(hit);
      if (parsed.success) return { data: parsed.data, model: "cache", cached: true, tokens: 0 };
    }
  }

  const system =
    `${params.system}\n\nReturn a single JSON object and nothing else. It must match this JSON Schema:\n` +
    JSON.stringify(z.toJSONSchema(params.schema));

  for (const model of availableModels(params.task)) {
    if ((coolingUntil.get(model.id) ?? 0) > Date.now()) continue;
    if (!(await withinBudget(model))) continue;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: params.prompt },
    ];

    try {
      // One repair attempt on the same model: a model that returned almost
      // the right shape usually fixes it when shown the validation error, and
      // that is cheaper than starting over elsewhere.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { text, tokens } = await callOnce(model, messages, params);
        await recordUsage(model, tokens);

        let problem: string;
        try {
          const parsed = params.schema.safeParse(extractJSON(text));
          if (parsed.success) {
            if (params.cache !== false) await writeCache(key, params.task, model, parsed.data, tokens);
            return { data: parsed.data, model: model.id, cached: false, tokens };
          }
          problem = z.prettifyError(parsed.error);
        } catch (err) {
          problem = err instanceof Error ? err.message : "invalid JSON";
        }

        messages.push(
          { role: "assistant", content: text.slice(0, 4000) },
          {
            role: "user",
            content: `That did not match the schema:\n${problem}\nReturn the corrected JSON object only.`,
          }
        );
      }
      console.warn(`[ai] ${model.id} could not produce valid output for task "${params.task}"`);
    } catch (err) {
      handleFailure(model, err);
    }
  }

  return null;
}

/** For tests: forget cooldowns and cached budgets between cases. */
export function resetRouterState() {
  coolingUntil.clear();
  budgetCache.clear();
  clients.clear();
}
