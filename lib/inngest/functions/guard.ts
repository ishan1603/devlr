import { EVENTS, inngest, type GuardAlertEvent, type GuardScanEvent } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase-admin";
import { abandonClaim, buildDedupeKey, claimDelivery, markFailed, markSent, releaseFailedClaim } from "@/lib/delivery/ledger";
import { localParts } from "@/lib/delivery/schedule";
import type { Issue } from "@/lib/delivery/issue";
import { sendIssueEmail } from "@/lib/email/send";
import { guardCopy } from "@/lib/guard/news";
import { dueRepositories, scanStoredRepo, type ScanOutcome } from "@/lib/guard/store";
import { loadGuardNews, markGuardNotified } from "@/lib/modules/guard";
import { mapLimit } from "@/lib/sources/http";

/**
 * Repo Guard's background work.
 *
 *   scan     one repository, now: when it is added, and when someone asks
 *   push     one repository, after a push to it has settled
 *   sweep    every watched repository, about once a day
 *   alert    one email, when a scan finds something that cannot wait
 *
 * A scan that finds something urgent does not send anything itself. It raises
 * an alert event, and the alert function decides: it waits for other scans of
 * the same reader's repositories to finish, and sends at most one such email
 * a day. Everything that is not urgent waits for the reader's regular issue.
 */

/** Repositories per step, and how many of those at once. A scan takes a few seconds. */
const SWEEP_BATCH = 4;
const SWEEP_PARALLEL = 2;
/** The most one sweep takes on. Four sweeps a day cover four times this. */
const SWEEP_LIMIT = Number(process.env.GUARD_SWEEP_LIMIT) || 200;

async function runScan(
  step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>; sendEvent: (id: string, payload: { name: string; data: GuardAlertEvent }) => Promise<unknown> },
  { repoId, force }: GuardScanEvent
) {
  const outcome = (await step.run("scan", () => scanStoredRepo(repoId, { force }))) as ScanOutcome;
  if (outcome.status === "scanned" && outcome.pendingUrgent > 0) {
    await step.sendEvent("raise-alert", { name: EVENTS.guardAlert, data: { userId: outcome.userId } });
  }
  return outcome;
}

/** A repository that was just added, or one someone asked to have scanned again. */
export const scanRepo = inngest.createFunction(
  {
    id: "guard-scan",
    triggers: [{ event: EVENTS.guardScan }],
    // The second limit keeps two scans of the same repository from overlapping.
    concurrency: [{ limit: 3 }, { key: "event.data.repoId", limit: 1 }],
    retries: 1,
  },
  async ({ event, step }) => runScan(step, event.data as GuardScanEvent)
);

/**
 * A repository that was pushed to.
 *
 * Debounced: a rebase or a run of small commits arrives as a burst of
 * webhooks, and the scan worth doing is the one after the last of them.
 */
export const scanPushedRepo = inngest.createFunction(
  {
    id: "guard-scan-push",
    triggers: [{ event: EVENTS.guardPush }],
    debounce: { key: "event.data.repoId", period: "2m" },
    concurrency: { limit: 2 },
    retries: 1,
  },
  async ({ event, step }) => runScan(step, { ...(event.data as GuardScanEvent), force: true })
);

/**
 * Re-checks every watched repository against today's advisories.
 *
 * This is how a reader hears about a vulnerability published after their last
 * commit. Most repositories have not changed since they were last read, so
 * for most of them this costs GitHub a single request.
 *
 * Runs four times a day and takes whatever is due, which spreads the work out
 * and means a repo that failed in the morning is tried again by evening.
 * Repositories are scanned a few per step rather than one function run each,
 * because a free background-job quota is counted in runs.
 */
export const sweepRepos = inngest.createFunction(
  {
    id: "guard-sweep",
    triggers: [{ cron: "10 */6 * * *" }, { event: EVENTS.guardSweep }],
    concurrency: { limit: 1 },
    retries: 0,
  },
  async ({ step }) => {
    const due = await step.run("list-due", () => dueRepositories(SWEEP_LIMIT));
    const totals = { due: due.length, scanned: 0, read: 0, skipped: 0, failed: 0, newFindings: 0 };
    const alert = new Set<string>();

    for (let i = 0; i < due.length; i += SWEEP_BATCH) {
      const batch = due.slice(i, i + SWEEP_BATCH);
      const outcomes = await step.run(`scan-${i / SWEEP_BATCH + 1}`, async () => {
        const results = await mapLimit(batch, SWEEP_PARALLEL, (repoId) => scanStoredRepo(repoId));
        return results.map(
          ({ item, result, error }): ScanOutcome => result ?? { status: "failed", repoId: item, error: error ?? "unknown error" }
        );
      });

      for (const outcome of outcomes as ScanOutcome[]) {
        if (outcome.status === "scanned") {
          totals.scanned++;
          totals.newFindings += outcome.added;
          if (outcome.read) totals.read++;
          if (outcome.pendingUrgent > 0) alert.add(outcome.userId);
        } else if (outcome.status === "skipped") {
          totals.skipped++;
        } else {
          totals.failed++;
        }
      }
    }

    if (alert.size > 0) {
      await step.sendEvent(
        "raise-alerts",
        [...alert].map((userId) => ({ name: EVENTS.guardAlert, data: { userId } satisfies GuardAlertEvent }))
      );
    }
    return { ...totals, alerted: alert.size };
  }
);

/**
 * The email that does not wait.
 *
 * Sent for findings that are urgent and that the reader has not been told are
 * urgent: a known malicious package, something being exploited in the wild,
 * or a critical flaw in shipped code that has a fix.
 *
 * Two brakes. The function is debounced per reader, so a sweep that finds the
 * same problem in three of their repositories produces one email, not three.
 * And the send is claimed under a key for the reader's local day, so there is
 * at most one of these a day whatever happens. Anything found after that is
 * still in their next regular issue.
 */
export const sendGuardAlert = inngest.createFunction(
  {
    id: "guard-alert",
    triggers: [{ event: EVENTS.guardAlert }],
    debounce: { key: "event.data.userId", period: "15m" },
    concurrency: { limit: 2 },
    retries: 2,
  },
  async ({ event, step, runId }) => {
    const { userId } = event.data as GuardAlertEvent;

    const reader = await step.run("load-reader", async () => {
      const supabase = createAdminClient();
      const [{ data: profile }, { data: subscription }] = await Promise.all([
        supabase
          .from("profiles")
          .select("email, timezone, is_paused, onboarded_at, unsubscribe_token, feed_token")
          .eq("user_id", userId)
          .maybeSingle(),
        supabase.from("subscriptions").select("is_active").eq("user_id", userId).eq("module", "repo_guard").maybeSingle(),
      ]);
      if (!profile) return { ok: false as const, reason: "profile not found" };
      // Paused means no mail at all. It is the reader's own switch, and an
      // alert that ignored it would teach them it does not work.
      if (profile.is_paused) return { ok: false as const, reason: "paused" };
      if (!profile.onboarded_at) return { ok: false as const, reason: "not onboarded" };
      if (!subscription?.is_active) return { ok: false as const, reason: "Repo Guard is switched off" };
      return {
        ok: true as const,
        to: profile.email as string,
        timezone: (profile.timezone as string) ?? "UTC",
        unsubscribeToken: profile.unsubscribe_token as string,
        feedToken: profile.feed_token as string,
      };
    });
    if (!reader.ok) return { cancelled: true, reason: reader.reason };

    const dedupeKey = buildDedupeKey("urgent", userId, localParts(reader.timezone, new Date()).date);
    const claim = await step.run("claim", () =>
      claimDelivery({ userId, dedupeKey, kind: "urgent", modules: ["repo_guard"], runId })
    );
    if (!claim.claimed) return { cancelled: true, reason: claim.reason };

    try {
      const composed = await step.run("compose", async () => {
        const news = await loadGuardNews(userId, { urgentOnly: true });
        if (!news.section) {
          // Urgent on paper, but in no report any more. Settle it, or every
          // scan from now on would raise this alert again.
          await markGuardNotified(news.findingIds);
          return null;
        }
        const issue: Issue = {
          ...guardCopy(news.section, true),
          date: new Date().toISOString(),
          sections: [news.section],
          aiEdited: false,
        };
        return { issue, refs: news.refs, findingIds: news.findingIds };
      });

      if (!composed) {
        // It was fixed, or announced, between the scan and now. Give today's
        // slot back so a real alert later today can still use it.
        await step.run("abandon-claim", () => abandonClaim(claim.deliveryId));
        return { skipped: true, reason: "nothing urgent any more" };
      }

      const sent = await step.run("send-email", () =>
        sendIssueEmail({
          to: reader.to,
          issue: composed.issue,
          webToken: claim.webToken,
          unsubscribeToken: reader.unsubscribeToken,
          feedToken: reader.feedToken,
        })
      );

      await step.run("record-sent", () =>
        markSent({
          deliveryId: claim.deliveryId,
          userId,
          issue: composed.issue,
          seen: composed.refs.map((ref) => ({ module: "repo_guard", itemType: "guard", ref })),
          modules: ["repo_guard"],
          // An alert is an extra. The regular issue keeps its own day.
          advanceSchedule: false,
          guardFindingIds: composed.findingIds,
        })
      );

      return { sent: true, dedupeKey, provider: sent.provider, subject: composed.issue.subject };
    } catch (error) {
      await step.run("record-failure", async () => {
        await markFailed(claim.deliveryId, error);
        await releaseFailedClaim(dedupeKey);
      });
      throw error;
    }
  }
);
