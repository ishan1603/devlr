import { inngest } from "@/lib/inngest/client";

/**
 * Runs the background jobs once, now, instead of waiting for their crons.
 *
 *   npm run jobs:kick
 *
 * A fresh install has an empty content pool, no lifecycle data and no trending
 * repos, so the first preview would have nothing in it for up to two hours.
 * This fills all three. Needs both `npm run dev` and `npm run dev:inngest`
 * running, because it only sends events; the app does the work.
 */
async function main() {
  const events = [
    { name: "content.ingest", data: {} },
    { name: "eol.refresh", data: {} },
    { name: "pulse.refresh", data: {} },
  ];

  try {
    await inngest.send(events);
  } catch (err) {
    console.error(
      "Could not reach Inngest. Is `npm run dev:inngest` running?\n",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }

  console.log("Queued: content.ingest, eol.refresh, pulse.refresh");
  console.log("Watch them run at http://localhost:8288 (ingest then enrich takes a few minutes).");
}

main();
