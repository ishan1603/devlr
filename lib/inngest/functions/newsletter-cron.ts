import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase-admin";
import { isDue, type Preference } from "@/lib/newsletter/schedule";
import { buildDedupeKey } from "@/lib/newsletter/dedupe";

/**
 * The recurring scheduler.
 *
 * This replaces the previous design, where each completed run queued its own
 * successor with a `ts` up to 14 days out. That chain had no way to recover: a
 * single failed run ended the series silently, pausing and resuming forked a
 * second concurrent chain, and locally the dev server forgets queued events on
 * restart. Polling on a fixed cron is stateless by comparison — if a tick is
 * missed, the next one still finds everyone who is owed a newsletter.
 */
export const newsletterCronFunction = inngest.createFunction(
  { id: "newsletter/cron", concurrency: { limit: 1 } },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const now = new Date();

    const active = await step.run("load-active-preferences", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("user_preferences")
        .select("user_id, email, categories, frequency, send_time, timezone, is_active, last_sent_at")
        .eq("is_active", true);

      if (error) throw new Error(`Failed to load preferences: ${error.message}`);
      return (data ?? []) as Preference[];
    });

    const due = active
      .map((pref) => ({ pref, verdict: isDue(pref, now) }))
      .filter((row) => row.verdict.due);

    if (due.length === 0) {
      return { checked: active.length, dispatched: 0 };
    }

    // The dedupe key makes this fan-out safe to repeat: if the cron double-fires
    // or a tick is retried, the same keys come back and the sends collapse.
    await step.sendEvent(
      "dispatch-due-newsletters",
      due.map(({ pref, verdict }) => ({
        name: "newsletter.schedule" as const,
        data: {
          userId: pref.user_id,
          kind: "recurring" as const,
          slot: verdict.slot,
          dedupeKey: buildDedupeKey("recurring", pref.user_id, verdict.slot),
        },
      }))
    );

    return {
      checked: active.length,
      dispatched: due.length,
      users: due.map(({ pref, verdict }) => `${pref.email} @ ${verdict.slot}`),
    };
  }
);
