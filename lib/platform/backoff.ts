/**
 * Retry scheduling for delivery jobs.
 *
 * Kept as pure functions with no database or clock dependency so the policy can
 * be tested directly, which matters more here than it looks: backoff bugs are
 * invisible in development (where nothing fails) and catastrophic in production
 * (where everything fails at once).
 */

/** First retry waits ~2s. */
const BASE_DELAY_MS = 2_000;

/** No retry ever waits longer than an hour. */
const MAX_DELAY_MS = 60 * 60 * 1_000;

/**
 * Exponential backoff with **full jitter**.
 *
 * The exponential part is obvious: a provider that just rejected us is unlikely
 * to be ready 100ms later, and hammering it converts a blip into an outage.
 *
 * The jitter is the part that is easy to leave out and expensive to omit.
 * Consider a provider that goes down for thirty seconds while 5,000 jobs are in
 * flight. Without jitter every one of those jobs fails at the same instant,
 * computes the identical delay, and retries at the same instant -- reproducing
 * the original thundering herd on a timer, forever, in lockstep. Spreading each
 * retry uniformly across `[0, ceiling)` decorrelates them, so the load arrives
 * smeared rather than spiked.
 *
 * This is AWS's "Full Jitter" from the Marc Brooker backoff post, chosen over
 * "Equal Jitter" because full jitter minimises contention at the cost of some
 * retries firing sooner than strictly necessary -- the right trade when the
 * scarce resource is the provider's rate limit rather than our own CPU.
 *
 * @param attempts How many attempts have already been made (1 after the first
 *                 failure). Values below 1 are clamped, so a caller that passes
 *                 a zeroed counter still gets the base delay rather than 0.
 * @param random   Injectable source of randomness in [0, 1), for deterministic
 *                 tests.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));

  // 2^30 ms already exceeds the cap by orders of magnitude; clamping the
  // exponent keeps the intermediate finite rather than relying on Math.min to
  // rescue an Infinity.
  const exponent = Math.min(safeAttempts - 1, 30);
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);

  return Math.floor(random() * ceiling);
}

/**
 * The absolute time a failed job becomes eligible again.
 *
 * `now` is injected rather than read from the clock so tests do not have to
 * reason about wall time.
 */
export function nextRunAfter(
  attempts: number,
  now: Date = new Date(),
  random: () => number = Math.random
): Date {
  return new Date(now.getTime() + backoffDelayMs(attempts, random));
}

/**
 * Whether a job has exhausted its budget and should go to the dead-letter state
 * instead of being rescheduled.
 *
 * Note that `attempts` is incremented at *claim* time, so by the time a failure
 * is reported this value already counts the attempt that just failed. The
 * comparison is therefore `>=`, not `>`: with `max_attempts = 5`, the fifth
 * failure is terminal.
 */
export function isExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/**
 * Classifies a delivery failure.
 *
 * The distinction drives whether we ever try again, and getting it wrong is
 * costly in both directions: retrying a hard bounce burns sender reputation,
 * while permanently failing a transient 4xx throws away a message that would
 * have gone out fine a minute later.
 *
 * SMTP encodes this in the first digit of the reply code -- 4xx is "try again",
 * 5xx is "do not" -- which is the same split providers expose over HTTP.
 */
export type FailureKind = "transient" | "permanent";

export function classifyFailure(statusCode: number | undefined, message: string): FailureKind {
  if (statusCode !== undefined) {
    // 429 is explicitly retryable despite being 4xx at the HTTP layer: it means
    // "slow down", not "never".
    if (statusCode === 429) return "transient";
    if (statusCode >= 500) return "transient";
    if (statusCode >= 400) return "permanent";
  }

  // No status code means the request never got an answer -- DNS failure, socket
  // timeout, connection reset. Those are transient by definition: we have no
  // evidence the provider rejected anything.
  const lower = message.toLowerCase();
  if (
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("socket")
  ) {
    return "transient";
  }

  return statusCode === undefined ? "transient" : "permanent";
}
