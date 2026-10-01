import { inngest } from "../client";
import { activeCategories, ingestCategories } from "@/lib/newsletter/pool";

/**
 * Fills the shared article pool, hourly.
 *
 * Only categories that at least one active subscriber has selected are fetched,
 * so an unused vertical never costs NewsAPI quota. Cost is now a function of how
 * many distinct categories exist (at most 8) rather than how many users there
 * are — which is the whole point of separating ingestion from delivery.
 */
export const ingestArticlesFunction = inngest.createFunction(
  { id: "articles/ingest", concurrency: { limit: 1 }, retries: 2 },
  [{ cron: "0 * * * *" }, { event: "articles.ingest" }],
  async ({ step }) => {
    const categories = await step.run("active-categories", activeCategories);

    if (categories.length === 0) {
      return { categories: [], fetched: 0, stored: 0, note: "no active subscribers" };
    }

    return await step.run("ingest", async () => ingestCategories(categories));
  }
);
