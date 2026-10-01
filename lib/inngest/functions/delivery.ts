import { EVENTS, inngest, type SendIssueEvent } from "@/lib/inngest/client";
import { createAdminClient, selectAll } from "@/lib/supabase-admin";
import { composeIssue, loadComposeContext } from "@/lib/delivery/compose";
import {
  buildDedupeKey,
  claimDelivery,
  markFailed,
  markSent,
  markSkipped,
  releaseFailedClaim,
} from "@/lib/delivery/ledger";
import {
  MODULE_ORDER,
  evaluateDue,
  type Module,
  type ScheduleProfile,
  type ScheduleSubscription,
} from "@/lib/delivery/schedule";
import { sendIssueEmail } from "@/lib/email/send";

/**
 * The scheduler.
 *
 * A stateless poll: every half hour it works out, for every active reader, in
 * their own timezone, whether anything is due. If a tick is missed, the next
 * one finds the same people. Nothing is ever queued for the future, so there
 * is no chain to break and nothing to cancel when a reader pauses.
 */
export const scheduleIssues = inngest.createFunction(
  {
    id: "delivery-scheduler",
    triggers: [{ cron: "*/30 * * * *" }],
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const now = new Date();

    const { profiles, subscriptions } = await step.run("load-active-readers", async () => {
      const supabase = createAdminClient();

      // Paged, and ordered by primary key so the pages cannot overlap. A plain
      // select would stop at 1,000 rows without saying so.
      const profiles = await selectAll((from, to) =>
        supabase
          .from("profiles")
          .select("user_id, timezone, send_time, is_paused, onboarded_at")
          .eq("is_paused", false)
          .not("onboarded_at", "is", null)
          .order("user_id")
          .range(from, to)
      );

      const subscriptions = await selectAll((from, to) =>
        supabase
          .from("subscriptions")
          .select("user_id, module, is_active, frequency, custom_interval_days, last_sent_at")
          .eq("is_active", true)
          .order("id")
          .range(from, to)
      );

      return { profiles, subscriptions };
    });

    const subsByUser = new Map<string, ScheduleSubscription[]>();
    for (const sub of subscriptions) {
      const list = subsByUser.get(sub.user_id as string) ?? [];
      list.push(sub as unknown as ScheduleSubscription);
      subsByUser.set(sub.user_id as string, list);
    }

    const due = (profiles as ScheduleProfile[])
      .map((profile) => ({ profile, verdict: evaluateDue(profile, subsByUser.get(profile.user_id) ?? [], now) }))
      .filter((row) => row.verdict.due);

    if (due.length === 0) return { checked: profiles.length, dispatched: 0 };

    // The dedupe key makes this fan-out safe to repeat. If the cron fires
    // twice or a tick is retried, the same keys come back and the sends
    // collapse into one.
    await step.sendEvent(
      "dispatch",
      due.map(({ profile, verdict }) => ({
        name: EVENTS.sendIssue,
        data: {
          userId: profile.user_id,
          kind: "scheduled",
          modules: verdict.modules,
          dedupeKey: buildDedupeKey("scheduled", profile.user_id, verdict.slot),
        } satisfies SendIssueEvent,
      }))
    );

    return { checked: profiles.length, dispatched: due.length };
  }
);

/**
 * Builds and sends one issue.
 *
 * Order matters. The send is claimed before any work, so a duplicate costs one
 * INSERT rather than a set of queries and a model call. A reader with nothing
 * new gets no email and keeps their claim for the day; a transient failure
 * releases the claim so the next tick can try again.
 */
export const sendIssue = inngest.createFunction(
  {
    id: "delivery-send",
    triggers: [{ event: EVENTS.sendIssue }],
    // First line of defence: duplicate events with the same key never start a
    // run. The unique index on deliveries.dedupe_key is the durable second.
    idempotency: "event.data.dedupeKey",
    // A 09:00 fan-out would otherwise stampede the SMTP provider.
    concurrency: { limit: 4 },
    retries: 2,
  },
  async ({ event, step, runId }) => {
    const { userId, kind, dedupeKey } = event.data as SendIssueEvent;

    // Re-read rather than trust the event: the reader may have paused or
    // changed their modules between dispatch and now.
    const context = await step.run("load-reader", async () => {
      const supabase = createAdminClient();
      const { data: profile } = await supabase
        .from("profiles")
        .select("is_paused, onboarded_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (!profile) return { ok: false as const, reason: "profile not found" };
      if (profile.is_paused) return { ok: false as const, reason: "paused" };
      if (!profile.onboarded_at) return { ok: false as const, reason: "not onboarded" };
      return { ok: true as const };
    });
    if (!context.ok) return { cancelled: true, reason: context.reason };

    const requested = ((event.data as SendIssueEvent).modules ?? []) as Module[];

    const claim = await step.run("claim", () =>
      claimDelivery({ userId, dedupeKey, kind, modules: requested, runId })
    );
    if (!claim.claimed) return { cancelled: true, reason: claim.reason };

    try {
      const composed = await step.run("compose", async () => {
        const loaded = await loadComposeContext(userId);
        if (!loaded) return null;

        const active = loaded.subscriptions.map((s) => s.module);
        // A manual send includes everything the reader has switched on. A
        // scheduled one includes what was due, minus anything since disabled.
        const modules =
          requested.length > 0 ? requested.filter((m) => active.includes(m)) : MODULE_ORDER.filter((m) => active.includes(m));

        const result = await composeIssue(loaded.profile, loaded.subscriptions, modules);
        if (!result) return null;

        return {
          ...result,
          to: loaded.profile.email,
          unsubscribeToken: loaded.profile.unsubscribe_token,
          feedToken: loaded.profile.feed_token,
        };
      });

      if (!composed) {
        // Not a failure: there was nothing new for this reader today.
        await step.run("record-skip", () => markSkipped(claim.deliveryId, "nothing new to send"));
        return { skipped: true, dedupeKey };
      }

      const sent = await step.run("send-email", () =>
        sendIssueEmail({
          to: composed.to,
          issue: composed.issue,
          webToken: claim.webToken,
          unsubscribeToken: composed.unsubscribeToken,
          feedToken: composed.feedToken,
        })
      );

      await step.run("record-sent", () =>
        markSent({
          deliveryId: claim.deliveryId,
          userId,
          issue: composed.issue,
          seen: composed.seen,
          modules: composed.contributing,
          advanceSchedule: kind === "scheduled",
        })
      );

      return {
        sent: true,
        dedupeKey,
        provider: sent.provider,
        subject: composed.issue.subject,
        modules: composed.contributing,
        aiEdited: composed.issue.aiEdited,
      };
    } catch (error) {
      // Record, then free the key so a later attempt can re-claim it. A
      // poisoned claim would silently skip this reader's day.
      await step.run("record-failure", async () => {
        await markFailed(claim.deliveryId, error);
        await releaseFailedClaim(dedupeKey);
      });
      throw error;
    }
  }
);
