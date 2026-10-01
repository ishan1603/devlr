import { inngest } from "../client";
import { assembleForUser, recordSentArticles } from "@/lib/newsletter/pool";
import { generateBriefing } from "@/lib/newsletter/briefing";
import { sendNewsletterEmail } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  buildDedupeKey,
  claimSend,
  immediateSlot,
  markFailed,
  markSent,
  markSkipped,
  releaseFailedClaim,
  type SendKind,
} from "@/lib/newsletter/dedupe";

export const scheduledNewsletterFunction = inngest.createFunction(
  {
    id: "newsletter/scheduled",
    // First line of defence: Inngest drops duplicate events carrying the same
    // key within its dedupe window, before a run is even created. The
    // newsletter_sends unique index is the durable second line.
    idempotency: "event.data.dedupeKey",
    // NewsAPI and Groq both rate-limit; a fan-out of every user at 09:00 would
    // otherwise stampede them.
    concurrency: { limit: 5 },
    retries: 3,
  },
  { event: "newsletter.schedule" },
  async ({ event, step, runId }) => {
    const userId: string = event.data.userId;
    const kind: SendKind = event.data.kind ?? "recurring";

    // Preferences are re-read here rather than trusted from the event payload:
    // a recurring event may have been queued days ago, and the user may have
    // paused or changed categories since.
    const pref = await step.run("load-preferences", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("user_preferences")
        .select("email, categories, frequency, is_active, unsubscribe_token")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw new Error(`Failed to load preferences: ${error.message}`);
      return data;
    });

    if (!pref) {
      return { cancelled: true, reason: "preferences not found" };
    }

    // This check previously ran only for recurring sends, so a newsletter
    // scheduled for next Tuesday still went out after the user hit pause.
    if (!pref.is_active) {
      return { cancelled: true, reason: "newsletter paused" };
    }

    if (!pref.categories?.length) {
      return { cancelled: true, reason: "no categories selected" };
    }

    const dedupeKey: string =
      event.data.dedupeKey ??
      buildDedupeKey(kind, userId, event.data.slot ?? immediateSlot());

    // Claim before doing any paid work, so a duplicate costs one INSERT rather
    // than a NewsAPI fetch plus a Groq completion.
    const claim = await step.run("claim-send", async () =>
      claimSend({
        userId,
        email: pref.email,
        dedupeKey,
        kind,
        categories: pref.categories,
        runId,
      })
    );

    if (!claim.claimed) {
      return { cancelled: true, reason: claim.reason, dedupeKey };
    }

    const sendId = claim.sendId;

    try {
      // Read from the shared pool rather than hitting NewsAPI per send. Two
      // users on the same categories now cost one fetch between them, and each
      // gets stories they have not already been shown.
      //
      // The logging lives inside the step deliberately: Inngest replays the
      // function body at every step boundary, so a console call out here would
      // fire once per step rather than once per send.
      const { articles: allArticles } = await step.run("assemble-from-pool", async () => {
        const result = await assembleForUser(userId, pref.categories);
        if (result.usedFallback.length > 0) {
          console.warn(`[newsletter] pool cold for ${result.usedFallback.join(", ")} — ingested on demand`);
        }
        if (result.skipped.length > 0) {
          console.info(`[newsletter] nothing new for ${result.skipped.join(", ")} — pool refreshed too recently to refetch`);
        }
        return result;
      });

      if (allArticles.length === 0) {
        // Not a failure: every story in the pool has already been sent to this
        // reader. Keep the claim so the slot is not reconsidered all day, and
        // leave a visible row rather than deleting the evidence.
        await step.run("record-skip", async () =>
          markSkipped(sendId, "no unseen articles available")
        );
        return { skipped: true, reason: "no unseen articles available", dedupeKey };
      }

      const briefing = await step.run("write-briefing", async () =>
        generateBriefing(allArticles, pref.categories)
      );

      await step.run("send-email", async () => {
        await sendNewsletterEmail({
          to: pref.email,
          articles: allArticles,
          briefing,
          unsubscribeToken: pref.unsubscribe_token,
        });
      });

      await step.run("record-success", async () => {
        await recordSentArticles(sendId, userId, allArticles);
        await markSent(sendId, allArticles.length);
        const supabase = createAdminClient();
        await supabase
          .from("user_preferences")
          .update({ last_sent_at: new Date().toISOString() })
          .eq("user_id", userId);
      });

      return {
        success: true,
        kind,
        dedupeKey,
        articleCount: allArticles.length,
        categories: pref.categories,
      };
    } catch (error) {
      // Record the failure, then free the key so a later attempt can re-claim
      // it. Leaving a poisoned claim behind would silently skip this slot.
      await step.run("record-failure", async () => {
        await markFailed(sendId, error);
        await releaseFailedClaim(dedupeKey);
      });
      throw error;
    }
  }
);
