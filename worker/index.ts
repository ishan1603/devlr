import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { claimJobs, completeJob, failJob, extendLease, type ClaimedJob } from "@/lib/platform/queue";
import { buildProviderPool, PermanentSendError, type ProviderPool } from "@/lib/platform/providers";

/**
 * The delivery worker.
 *
 * A long-lived process, deliberately outside Next.js. Serverless functions are
 * the wrong shape for this: they are billed and bounded by wall-clock time,
 * cannot hold an SMTP connection pool between invocations, and are killed
 * mid-flight at the timeout -- which for a send means the message may or may not
 * have gone out. A persistent process holds its connections, drains its work,
 * and shuts down on its own terms.
 *
 * Run several of these. They coordinate purely through the database, so scaling
 * out is starting another process and nothing else.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Jobs claimed per round trip. */
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 20);

/** Sends attempted simultaneously within a batch. */
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 10);

/**
 * How long a claim is held before other workers may reclaim it.
 *
 * Short enough that a crashed worker's jobs are picked up promptly, and kept
 * safe for genuinely slow sends by the heartbeat below rather than by inflating
 * this number.
 */
const LEASE_SECONDS = Number(process.env.WORKER_LEASE_SECONDS ?? 60);

/** Leases are extended at a third of their length, leaving room to miss one. */
const HEARTBEAT_MS = (LEASE_SECONDS * 1000) / 3;

const MIN_IDLE_MS = Number(process.env.WORKER_MIN_IDLE_MS ?? 250);
const MAX_IDLE_MS = Number(process.env.WORKER_MAX_IDLE_MS ?? 5_000);

/** Grace period for in-flight sends to finish during shutdown. */
const SHUTDOWN_GRACE_MS = Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 30_000);

const WORKER_ID = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let running = true;
const inFlight = new Set<number>();

const stats = {
  claimed: 0,
  sent: 0,
  retried: 0,
  dead: 0,
  startedAt: Date.now(),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Structured single-line JSON. Log aggregators parse this without a custom
  // pattern, and it stays greppable by field when all you have is a terminal.
  console.log(JSON.stringify({ ts: new Date().toISOString(), worker: WORKER_ID, event, ...fields }));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function deliver(job: ClaimedJob, pool: ProviderPool): Promise<void> {
  inFlight.add(job.id);

  try {
    const result = await pool.send({
      to: job.message.to_email,
      from: job.message.from_email,
      subject: job.message.subject,
      html: job.message.html_body,
      text: job.message.text_body,
    });

    await completeJob(job.id, result.provider, result.providerMessageId);
    stats.sent += 1;

    log("sent", { job: job.id, message: job.message_id, provider: result.provider });
  } catch (error) {
    const permanent = error instanceof PermanentSendError;

    const dead = await failJob(job, error, { permanent });

    if (dead) {
      stats.dead += 1;
      log("dead_lettered", {
        job: job.id,
        message: job.message_id,
        attempts: job.attempts,
        permanent,
        error: (error as Error).message,
      });
    } else {
      stats.retried += 1;
      log("retry_scheduled", {
        job: job.id,
        message: job.message_id,
        attempts: job.attempts,
        error: (error as Error).message,
      });
    }
  } finally {
    inFlight.delete(job.id);
  }
}

/**
 * Runs a batch with bounded concurrency.
 *
 * A plain `Promise.all` over the batch would open every connection at once,
 * which both blows past the provider's rate limit and makes memory use a
 * function of batch size. Instead a fixed number of workers pull from a shared
 * cursor, so concurrency stays flat no matter how large the batch is.
 */
async function processBatch(jobs: ClaimedJob[], pool: ProviderPool): Promise<void> {
  let cursor = 0;

  const runners = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      await deliver(jobs[index], pool);
    }
  });

  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Periodically extends the lease on everything currently in flight.
 *
 * Without this, a send that legitimately takes longer than the lease would be
 * reclaimed by another worker and delivered twice. Lengthening the lease instead
 * would fix the duplicate at the cost of slow crash recovery for every job; the
 * heartbeat gets both.
 */
function startHeartbeat(): NodeJS.Timeout {
  return setInterval(async () => {
    const ids = [...inFlight];
    if (ids.length === 0) return;

    try {
      await extendLease(ids, WORKER_ID, LEASE_SECONDS);
    } catch (error) {
      // Not fatal on its own: one missed heartbeat still leaves most of the
      // lease. It matters only if it keeps failing, which the log will show.
      log("heartbeat_failed", { error: (error as Error).message, jobs: ids.length });
    }
  }, HEARTBEAT_MS);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Stops claiming and lets in-flight sends finish.
 *
 * Exiting immediately on SIGTERM would abandon sends whose outcome is unknown --
 * the provider may well have accepted them -- and leave their leases to expire
 * before another worker retried them, producing duplicates. Draining first turns
 * a deploy or a scale-down into a non-event.
 *
 * The grace period is bounded because orchestrators send SIGKILL if you take too
 * long, and it is better to stop on our own terms than to be killed mid-write.
 */
async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;

  log("shutdown_started", { signal, in_flight: inFlight.size });

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await sleep(100);
  }

  if (inFlight.size > 0) {
    // These keep their leases and are reclaimed by another worker once those
    // expire, so nothing is lost -- but it is worth being loud about.
    log("shutdown_forced", { abandoned: inFlight.size });
  }

  log("shutdown_complete", { ...stats, uptime_s: Math.round((Date.now() - stats.startedAt) / 1000) });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pool = buildProviderPool();

  log("worker_started", {
    batch_size: BATCH_SIZE,
    concurrency: CONCURRENCY,
    lease_seconds: LEASE_SECONDS,
    providers: Object.keys(pool.health),
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const heartbeat = startHeartbeat();

  // Grows while the queue is empty and resets the moment work appears. A fixed
  // fast poll would hammer the database with claim queries -- each one a write --
  // through every quiet period, which on a mostly-idle queue is nearly all of
  // the load the system generates.
  let idleDelay = MIN_IDLE_MS;

  while (running) {
    try {
      const jobs = await claimJobs(WORKER_ID, BATCH_SIZE, LEASE_SECONDS);

      if (jobs.length === 0) {
        await sleep(idleDelay);
        idleDelay = Math.min(idleDelay * 2, MAX_IDLE_MS);
        continue;
      }

      stats.claimed += jobs.length;
      idleDelay = MIN_IDLE_MS;

      await processBatch(jobs, pool);
    } catch (error) {
      // A failure here is the claim itself failing -- the database is
      // unreachable or overloaded. Backing off is the only useful response;
      // spinning would add load to something already struggling.
      log("loop_error", { error: (error as Error).message });
      await sleep(MAX_IDLE_MS);
    }
  }

  clearInterval(heartbeat);
}

main().catch((error) => {
  log("fatal", { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
