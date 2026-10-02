import { createAdminClient } from "@/lib/supabase-admin";
import type { Issue } from "@/lib/delivery/issue";
import { markGuardNotified } from "@/lib/modules/guard";

export type DeliveryKind = "scheduled" | "manual" | "urgent" | "preview";

/**
 * A dedupe key names the *logical* email, not the attempt.
 *
 * Two events that both mean "the issue this user is owed on Tuesday" must
 * produce the same string, so the unique index on deliveries.dedupe_key
 * collapses them into one email no matter how many events or retries occur.
 */
export function buildDedupeKey(kind: DeliveryKind, userId: string, slot: string): string {
  return `${kind}:${userId}:${slot}`;
}

/** Minute-resolution bucket, so a double-clicked "Send now" is one email. */
export function manualSlot(now: Date = new Date()): string {
  return now.toISOString().slice(0, 16);
}

export type ClaimResult =
  | { claimed: true; deliveryId: string; webToken: string }
  | { claimed: false; reason: string };

/**
 * Attempt to claim a send. Exactly one caller wins per dedupe key.
 *
 * The claim is an INSERT, so the uniqueness check and the reservation are one
 * atomic operation. A check-then-insert would leave a window where two
 * concurrent runs both read "nothing sent yet" and both proceed.
 */
export async function claimDelivery(params: {
  userId: string;
  dedupeKey: string;
  kind: DeliveryKind;
  modules: string[];
  runId?: string;
}): Promise<ClaimResult> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("deliveries")
    .insert({
      user_id: params.userId,
      dedupe_key: params.dedupeKey,
      kind: params.kind,
      modules: params.modules,
      status: "sending",
      run_id: params.runId ?? null,
    })
    .select("id, web_token")
    .single();

  if (error) {
    // 23505 = unique_violation: someone already claimed this exact send.
    if (error.code === "23505") {
      return { claimed: false, reason: `duplicate send suppressed (${params.dedupeKey})` };
    }
    throw new Error(`Failed to claim delivery ${params.dedupeKey}: ${error.message}`);
  }

  return { claimed: true, deliveryId: data.id, webToken: data.web_token };
}

export interface SeenRef {
  module: string;
  itemType: string;
  ref: string;
  canonicalUrl?: string | null;
}

/**
 * Close out a successful send: store the issue for the archive, remember what
 * the reader was shown, and, for a scheduled send, advance each module's
 * clock.
 *
 * A manual "send me one now" deliberately leaves the clock alone. It is an
 * extra, and letting it count would move the reader's regular issue to a
 * different day without their asking. What it contained is still recorded as
 * seen, so the regular issue will not repeat it.
 */
export async function markSent(params: {
  deliveryId: string;
  userId: string;
  issue: Issue;
  seen: SeenRef[];
  modules: string[];
  advanceSchedule: boolean;
  /** Repo Guard findings this issue announced. */
  guardFindingIds?: number[];
}) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // First, because it is the one that matters most if a later write fails: an
  // issue recorded as unsent is harmless, a security finding announced twice
  // is the thing this whole table exists to prevent.
  await markGuardNotified(params.guardFindingIds ?? []);

  if (params.seen.length > 0) {
    const { error } = await supabase.from("delivery_items").upsert(
      params.seen.map((s) => ({
        delivery_id: params.deliveryId,
        user_id: params.userId,
        module: s.module,
        item_type: s.itemType,
        ref: s.ref,
        canonical_url: s.canonicalUrl ?? null,
      })),
      { onConflict: "delivery_id,item_type,ref", ignoreDuplicates: true }
    );
    if (error) throw new Error(`Failed to record delivered items: ${error.message}`);
  }

  const { error } = await supabase
    .from("deliveries")
    .update({
      status: "sent",
      sent_at: now,
      subject: params.issue.subject,
      preheader: params.issue.preheader,
      payload: params.issue,
      item_count: params.seen.length,
      modules: params.modules,
    })
    .eq("id", params.deliveryId);
  if (error) throw new Error(`Failed to mark delivery sent: ${error.message}`);

  if (params.advanceSchedule && params.modules.length > 0) {
    await supabase
      .from("subscriptions")
      .update({ last_sent_at: now })
      .eq("user_id", params.userId)
      .in("module", params.modules);
  }
  await supabase.from("profiles").update({ last_delivery_at: now }).eq("user_id", params.userId);
}

/**
 * Close out a send that had nothing to deliver.
 *
 * Deliberately keeps the claim. The key is slot-scoped
 * (`scheduled:<user>:2026-10-01`), so holding it means "today is resolved" and
 * the cron stops reconsidering this user every tick. A genuine failure takes
 * the other path and releases instead.
 */
export async function markSkipped(deliveryId: string, reason: string) {
  const supabase = createAdminClient();
  await supabase
    .from("deliveries")
    .update({ status: "skipped", error: reason, item_count: 0 })
    .eq("id", deliveryId);
}

/**
 * Give a claim back without having sent anything.
 *
 * For a send that turned out to have no reason to exist, where the slot should
 * stay free: an alert whose cause was fixed before it could go out. Unlike a
 * skip, which deliberately keeps the day resolved.
 */
export async function abandonClaim(deliveryId: string) {
  const supabase = createAdminClient();
  await supabase.from("deliveries").delete().eq("id", deliveryId).eq("status", "sending");
}

export async function markFailed(deliveryId: string, err: unknown) {
  const supabase = createAdminClient();
  await supabase
    .from("deliveries")
    .update({ status: "failed", error: err instanceof Error ? err.message : String(err) })
    .eq("id", deliveryId);
}

/**
 * Release a failed claim so a later run can retry.
 *
 * Without this a transient SMTP error would poison the dedupe key forever and
 * the reader would silently never receive that day's issue.
 */
export async function releaseFailedClaim(dedupeKey: string) {
  const supabase = createAdminClient();
  await supabase.from("deliveries").delete().eq("dedupe_key", dedupeKey).eq("status", "failed");
}

/** Everything a reader has been shown recently, for exclusion at assembly. */
export async function loadSeen(
  userId: string,
  itemType: string,
  days = 90
): Promise<{ refs: Set<string>; urls: Set<string> }> {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Newest first: responses are capped at 1,000 rows, and if a heavy reader
  // ever exceeds that, the rows to lose are the oldest. Those are about
  // articles long outside any issue's window, so dropping them is harmless,
  // whereas dropping an arbitrary thousand could repeat last week's stories.
  const { data, error } = await supabase
    .from("delivery_items")
    .select("ref, canonical_url")
    .eq("user_id", userId)
    .eq("item_type", itemType)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`Failed to load seen items: ${error.message}`);

  const refs = new Set<string>();
  const urls = new Set<string>();
  for (const row of data ?? []) {
    refs.add(row.ref as string);
    if (row.canonical_url) urls.add(row.canonical_url as string);
  }
  return { refs, urls };
}
