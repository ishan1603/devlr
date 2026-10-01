import OpenAI from "openai";
import { MODELS, ROUTES, type ModelSpec } from "@/lib/ai/providers";
import { embeddingsEnabled, embedText } from "@/lib/ai/embed";

/**
 * Checks that every pinned model is still served, and that each key works.
 *
 *   npm run ai:check
 *
 * Free tiers retire models without notice. The router survives that by falling
 * back, which is exactly why a dead pin is easy to miss: output just gets
 * quietly worse. Run this when summaries or subject lines start looking flat.
 */
async function check(model: ModelSpec): Promise<string> {
  const key = process.env[model.apiKeyEnv];
  if (!key) return `skip   no ${model.apiKeyEnv}`;

  const client = new OpenAI({ apiKey: key, baseURL: model.baseURL, maxRetries: 0, timeout: 20_000 });
  try {
    const completion = await client.chat.completions.create({
      model: model.model,
      messages: [{ role: "user", content: 'Reply with the JSON object {"ok": true} and nothing else.' }],
      max_completion_tokens: 200,
      response_format: { type: "json_object" },
      ...(model.extra as object),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);
    const tokens = completion.usage?.total_tokens ?? 0;
    return `ok     ${tokens} tokens`;
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      const hint = err.status === 404 ? "  <- pin is dead, update lib/ai/providers.ts" : "";
      return `FAIL   HTTP ${err.status}: ${String(err.message).slice(0, 90)}${hint}`;
    }
    return `FAIL   ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main() {
  let failures = 0;

  console.log("Models");
  for (const model of Object.values(MODELS) as ModelSpec[]) {
    const result = await check(model);
    if (result.startsWith("FAIL")) failures++;
    console.log(`  ${model.id.padEnd(22)} ${model.model.padEnd(28)} ${result}`);
  }

  console.log("\nRouting (first available model per task)");
  for (const [task, models] of Object.entries(ROUTES)) {
    const first = models.find((m) => process.env[m.apiKeyEnv]);
    console.log(`  ${task.padEnd(10)} ${first ? first.id : "NONE: every send will use template copy"}`);
  }

  console.log("\nEmbeddings");
  if (!embeddingsEnabled()) {
    console.log("  skip   no GEMINI_API_KEY (duplicates fall back to title matching, relevance to tags)");
  } else {
    try {
      const vector = await embedText("Postgres 18 ships asynchronous I/O");
      console.log(`  ok     ${vector?.length} dimensions`);
    } catch (err) {
      failures++;
      console.log(`  FAIL   ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) process.exitCode = 1;
}

main();
