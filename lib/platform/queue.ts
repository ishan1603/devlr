import { createAdminClient } from "@/lib/supabase-admin";
import { classifyFailure, nextRunAfter } from "@/lib/platform/backoff";

/**
 * Queue operations.
 *
 * Every multi-row mutation goes through a Postgres function rather than a
 * sequence of client calls -- see supabase/platform-schema.sql for why. This
 * module is the typed surface over those functions, not a second place where
 * the rules live.
 *
 * Uses the service-role client throughout: the queue has no signed-in user, and
 * these tables carry no RLS policy that would grant access to anyone else.
 */

export interface DeliveryJob {
  id: number;
  message_id: string;
  status: "pending" | "active" | "succeeded" | "dead";
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_expires_at: string | null;
  locked_by: string | null;
  last_error: string | null;
}

export interface ClaimedJob extends DeliveryJob {
  message: {
    id: string;
    tenant_id: string;
    to_email: string;
    from_email: string;
    subject: string;
    html_body: string | null;
    text_body: string | null;
  };
}

export interface EnqueueInput {
  tenantId: string;
  idempotencyKey?: string | null;
  to: string;
  from: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  scheduledFor?: Date | null;
}

export interface EnqueueResult {
  messageId: string;
  status: string;
  /** False when this call resolved to an existing idempotency key. */
  created: boolean;
}

export async function enqueueMessage(input: EnqueueInput): Promise<EnqueueResult> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("enqueue_message", {
    p_tenant_id: input.tenantId,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_to: input.to,
    p_from: input.from,
    p_subject: input.subject,
    p_html: input.html ?? null,
    p_text: input.text ?? null,
    p_scheduled_for: input.scheduledFor?.toISOString() ?? null,
  });

  if (error) throw new Error(`enqueue_message failed: ${error.message}`);

  // The function returns a one-row table; supabase-js surfaces that as an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("enqueue_message returned no row");

  return {
    messageId: row.message_id,
    status: row.message_status,
    created: row.created,
  };
}

/**
 * Claims a batch of jobs for this worker.
 *
 * The message bodies are fetched in a second query rather than joined into the
 * claim function, because the claim is a write that holds row locks for its
 * duration: every extra table it touches widens the window in which other
 * workers contend. Claim narrowly, then read.
 */
export async function claimJobs(
  workerId: string,
  batchSize: number,
  leaseSeconds: number
): Promise<ClaimedJob[]> {
  const supabase = createAdminClient();

  const { data: jobs, error } = await supabase.rpc("claim_delivery_jobs", {
    p_worker_id: workerId,
    p_batch_size: batchSize,
    p_lease_seconds: leaseSeconds,
  });

  if (error) throw new Error(`claim_delivery_jobs failed: ${error.message}`);
  if (!jobs || jobs.length === 0) return [];

  const messageIds = jobs.map((j: DeliveryJob) => j.message_id);

  const { data: messages, error: messageError } = await supabase
    .from("platform_messages")
    .select("id, tenant_id, to_email, from_email, subject, html_body, text_body")
    .in("id", messageIds);

  if (messageError) {
    throw new Error(`loading claimed messages failed: ${messageError.message}`);
  }

  const byId = new Map((messages ?? []).map((m) => [m.id, m]));

  // A job whose message vanished between the claim and this read has nothing
  // left to send. Dropping it here means the lease simply expires and the job is
  // reclaimed, which is wrong only in that it wastes attempts -- so it is
  // dead-lettered explicitly instead.
  const claimed: ClaimedJob[] = [];
  for (const job of jobs as DeliveryJob[]) {
    const message = byId.get(job.message_id);
    if (!message) {
      await failJob(job, new Error("message row missing"), { permanent: true });
      continue;
    }
    claimed.push({ ...job, message });
  }

  return claimed;
}

export async function completeJob(
  jobId: number,
  provider: string,
  providerMessageId: string | null
): Promise<void> {
  const supabase = createAdminClient();

  const { error } = await supabase.rpc("complete_delivery_job", {
    p_job_id: jobId,
    p_provider: provider,
    p_provider_message_id: providerMessageId,
  });

  if (error) throw new Error(`complete_delivery_job failed: ${error.message}`);
}

export interface FailOptions {
  /** Skip the remaining retry budget -- the provider told us never to retry. */
  permanent?: boolean;
  statusCode?: number;
  /** Injectable for tests. */
  now?: Date;
  random?: () => number;
}

/**
 * Reports a failed attempt, rescheduling it with backoff or dead-lettering it.
 *
 * Returns true when the job was dead-lettered.
 */
export async function failJob(
  job: Pick<DeliveryJob, "id" | "attempts" | "max_attempts">,
  error: unknown,
  options: FailOptions = {}
): Promise<boolean> {
  const supabase = createAdminClient();

  const message = error instanceof Error ? error.message : String(error);

  const permanent =
    options.permanent ?? classifyFailure(options.statusCode, message) === "permanent";

  const runAfter = nextRunAfter(job.attempts, options.now ?? new Date(), options.random);

  const { data, error: rpcError } = await supabase.rpc("fail_delivery_job", {
    p_job_id: job.id,
    // Postgres text columns reject NUL bytes, which provider errors occasionally
    // carry through from raw socket output.
    p_error: message.replace(/\0/g, "").slice(0, 2000),
    p_permanent: permanent,
    p_run_after: runAfter.toISOString(),
  });

  if (rpcError) throw new Error(`fail_delivery_job failed: ${rpcError.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  return Boolean(row?.dead);
}

/**
 * Extends the lease on jobs still being worked.
 *
 * A lease is a bet on how long a send takes. Set it too short and a slow-but-
 * healthy provider causes jobs to be reclaimed and sent twice; too long and a
 * genuinely dead worker's jobs sit idle until it expires. Heartbeating lets the
 * lease stay short -- so crash recovery is fast -- while still covering the
 * occasional slow send.
 */
export async function extendLease(
  jobIds: number[],
  workerId: string,
  leaseSeconds: number
): Promise<void> {
  if (jobIds.length === 0) return;

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("platform_delivery_jobs")
    .update({
      lease_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in("id", jobIds)
    // Only extend leases we still hold. If another worker reclaimed a job after
    // our lease lapsed, silently pushing its expiry forward would hand us back a
    // job that is actively being sent by someone else.
    .eq("locked_by", workerId)
    .eq("status", "active");

  if (error) throw new Error(`extending lease failed: ${error.message}`);
}
