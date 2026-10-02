import { EVENTS, inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase-admin";
import { ingestSources, sourceBatches, syncSources } from "@/lib/content/ingest";
import { enrichBatch } from "@/lib/content/enrich";
import { activePulseLanguages, refreshPulseLanguage } from "@/lib/modules/pulse";
import { refreshEol } from "@/lib/modules/eol";

/**
 * Fills the shared pool, every two hours.
 *
 * Sources are fetched in batches, one step each, so a slow or failing batch is
 * retried alone and a single request never has to outlive a serverless
 * timeout. Cost is a function of how many sources exist, never of how many
 * readers there are.
 */
export const ingestContent = inngest.createFunction(
  {
    id: "content-ingest",
    triggers: [{ cron: "5 */2 * * *" }, { event: "content.ingest" }],
    concurrency: { limit: 1 },
    retries: 2,
  },
  async ({ step }) => {
    await step.run("sync-sources", syncSources);

    const batches = sourceBatches();
    const totals = { fetched: 0, inserted: 0, updated: 0, notModified: 0, failed: [] as string[] };

    for (let i = 0; i < batches.length; i++) {
      const report = await step.run(`ingest-batch-${i + 1}`, () => ingestSources(batches[i]));
      totals.fetched += report.fetched;
      totals.inserted += report.inserted;
      totals.updated += report.updated;
      totals.notModified += report.notModified;
      totals.failed.push(...report.failed.map((f) => `${f.id}: ${f.error}`));
    }

    if (totals.inserted > 0) {
      await step.sendEvent("request-enrichment", { name: EVENTS.enrich, data: {} });
    }
    return totals;
  }
);

/** Rounds of enrichment per run. Each round is one batch of articles. */
const MAX_ENRICH_ROUNDS = 8;

/**
 * Embeds, clusters and summarises whatever ingestion brought in.
 *
 * Runs in rounds with a pause between them. The pause is not politeness: the
 * free model tiers allow about 8K tokens a minute, and a round of summaries
 * uses most of that. Spreading the work out is what keeps it on the best model
 * instead of falling down the fallback chain.
 */
export const enrichContent = inngest.createFunction(
  {
    id: "content-enrich",
    // The hourly cron is a safety net for a missed event; the event is what
    // normally triggers it, straight after an ingest.
    triggers: [{ event: EVENTS.enrich }, { cron: "35 * * * *" }],
    concurrency: { limit: 1 },
    retries: 1,
  },
  async ({ step }) => {
    const totals = { processed: 0, summarized: 0, aiSummaries: 0, joined: 0, rejected: 0, rounds: 0 };

    for (let round = 0; round < MAX_ENRICH_ROUNDS; round++) {
      const report = await step.run(`enrich-${round + 1}`, () => enrichBatch(20));
      if (report.processed === 0) break;

      totals.rounds++;
      totals.processed += report.processed;
      totals.summarized += report.summarized;
      totals.aiSummaries += report.aiSummaries;
      totals.joined += report.joined;
      totals.rejected += report.rejected;

      if (report.processed < 20) break;
      await step.sleep(`pace-${round + 1}`, "45s");
    }
    return totals;
  }
);

/**
 * Dev Pulse: trending repositories, once a day.
 *
 * Unauthenticated GitHub search allows ten requests a minute, so languages go
 * in small groups with a pause between groups.
 */
export const refreshPulse = inngest.createFunction(
  {
    id: "pulse-refresh",
    triggers: [{ cron: "20 5 * * *" }, { event: "pulse.refresh" }],
    concurrency: { limit: 1 },
    retries: 1,
  },
  async ({ step }) => {
    const languages = await step.run("active-languages", activePulseLanguages);
    const groupSize = process.env.GITHUB_TOKEN ? 20 : 6;
    let stored = 0;

    for (let i = 0; i < languages.length; i += groupSize) {
      const group = languages.slice(i, i + groupSize);
      stored += await step.run(`fetch-${i / groupSize + 1}`, async () => {
        let count = 0;
        for (const language of group) {
          try {
            count += await refreshPulseLanguage(language);
          } catch (err) {
            // One language failing (usually a rate limit) should not cost the rest.
            console.warn(`[pulse] ${language} failed:`, err);
          }
        }
        return count;
      });
      if (i + groupSize < languages.length) await step.sleep(`pace-${i / groupSize + 1}`, "65s");
    }

    return { languages: languages.length, stored };
  }
);

/** EOL Watch: lifecycle dates, once a day. */
export const refreshLifecycles = inngest.createFunction(
  {
    id: "eol-refresh",
    triggers: [{ cron: "40 4 * * *" }, { event: "eol.refresh" }],
    concurrency: { limit: 1 },
    retries: 2,
  },
  async ({ step }) => step.run("refresh", () => refreshEol())
);

/** Keeps the database inside the free tier. See prune_old_data in the schema. */
export const pruneData = inngest.createFunction(
  { id: "maintenance-prune", triggers: [{ cron: "15 3 * * *" }], retries: 1 },
  async ({ step }) => {
    const content = await step.run("prune", async () => {
      const { data, error } = await createAdminClient().rpc("prune_old_data", { p_content_days: 60 });
      if (error) throw new Error(`Prune failed: ${error.message}`);
      return data;
    });
    const guard = await step.run("prune-guard", async () => {
      const { data, error } = await createAdminClient().rpc("prune_guard_data");
      if (error) throw new Error(`Repo Guard prune failed: ${error.message}`);
      return data;
    });
    return { content, guard };
  }
);
