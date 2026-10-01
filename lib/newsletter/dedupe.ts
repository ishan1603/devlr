import { createAdminClient } from "@/lib/supabase-admin";

export type SendKind = "immediate" | "scheduled" | "recurring";

/**
 * A dedupe key names the *logical* send, not the attempt.
 *
 * Two events that mean "the newsletter Ishan is owed for Tuesday morning" must
 * produce the same string, so the unique index on newsletter_sends.dedupe_key
 * collapses them into one email no matter how many events or retries occur.
 */
export function buildDedupeKey(
  kind: SendKind,
  userId: string,
  slot: string
): string {
  return `${kind}:${userId}:${slot}`;
}

/** Minute-resolution bucket, so a double-clicked "Send Now" is one newsletter. */
export function immediateSlot(now: Date = new Date()): string {
  return now.toISOString().slice(0, 16);
}

export type ClaimResult =
  | { claimed: true; sendId: string }
  | { claimed: false; reason: string };

/**
 * Attempt to claim a send. Exactly one caller wins per dedupe_key.
 *
 * The claim is an INSERT, so the uniqueness check and the reservation are a
 * single atomic operation — a check-then-insert would leave a window where two
 * concurrent runs both read "no send yet" and both proceed.
 */
export async function claimSend(params: {
  userId: string;
  email: string;
  dedupeKey: string;
  kind: SendKind;
  categories: string[];
  runId?: string;
}): Promise<ClaimResult> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("newsletter_sends")
    .insert({
      user_id: params.userId,
      email: params.email,
      dedupe_key: params.dedupeKey,
      send_kind: params.kind,
      categories: params.categories,
      status: "sending",
      run_id: params.runId ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation: someone already claimed this exact send.
    if (error.code === "23505") {
      return { claimed: false, reason: `duplicate send suppressed (${params.dedupeKey})` };
    }
    throw new Error(`Failed to claim send ${params.dedupeKey}: ${error.message}`);
  }

  return { claimed: true, sendId: data.id };
}

export async function markSent(sendId: string, articleCount: number) {
  const supabase = createAdminClient();
  await supabase
    .from("newsletter_sends")
    .update({ status: "sent", sent_at: new Date().toISOString(), article_count: articleCount })
    .eq("id", sendId);
}

/**
 * Close out a send that had nothing to deliver.
 *
 * Deliberately keeps the claim. The dedupe key is slot-scoped
 * (`recurring:<user>:2026-09-09`), so holding it means "today's slot is
 * resolved" and the cron stops reconsidering this user every 15 minutes. A
 * genuine transient failure takes the other path and releases instead.
 */
export async function markSkipped(sendId: string, reason: string) {
  const supabase = createAdminClient();
  await supabase
    .from("newsletter_sends")
    .update({ status: "skipped", error: reason, article_count: 0 })
    .eq("id", sendId);
}

/**
 * Release a failed claim so a later run can retry.
 *
 * Without this a transient SMTP error would poison the dedupe key forever and
 * the user would silently never receive that slot's newsletter.
 */
export async function markFailed(sendId: string, err: unknown) {
  const supabase = createAdminClient();
  await supabase
    .from("newsletter_sends")
    .update({
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    })
    .eq("id", sendId);
}

/** A failed row is retryable: drop it so the next attempt can re-claim the key. */
export async function releaseFailedClaim(dedupeKey: string) {
  const supabase = createAdminClient();
  await supabase
    .from("newsletter_sends")
    .delete()
    .eq("dedupe_key", dedupeKey)
    .eq("status", "failed");
}
