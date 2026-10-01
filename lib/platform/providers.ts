import nodemailer, { type Transporter } from "nodemailer";

/**
 * Email providers and the failover logic across them.
 *
 * A single provider is a single point of failure that you do not control. SES
 * has had multi-hour regional outages; Gmail's SMTP silently throttles a free
 * account near 500 recipients a day. Neither is a bug you can fix, so the
 * platform treats "the provider is unavailable" as an expected state and routes
 * around it.
 */

export interface OutboundMessage {
  to: string;
  from: string;
  subject: string;
  html: string | null;
  text: string | null;
}

export interface SendResult {
  providerMessageId: string | null;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Thrown when a provider rejects a message in a way that must not be retried --
 * a malformed address, a rejected sender domain. The worker uses this rather
 * than guessing from the message text where the provider was explicit.
 */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSendError";
  }
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  /** Connections held open across sends. */
  maxConnections?: number;
}

export class SmtpProvider implements EmailProvider {
  readonly name: string;
  private transporter: Transporter;

  constructor(config: SmtpConfig) {
    this.name = config.name;

    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,

      // Connection pooling is the single biggest throughput lever here. Without
      // it every send pays a fresh TCP handshake plus a TLS negotiation plus the
      // SMTP greeting -- easily 200-400ms of pure setup against a remote server,
      // which dwarfs the send itself and caps throughput at a few messages per
      // second per worker no matter how much concurrency is configured.
      pool: true,
      maxConnections: config.maxConnections ?? 5,
      maxMessages: Infinity,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        to: message.to,
        from: message.from,
        subject: message.subject,
        html: message.html ?? undefined,
        text: message.text ?? undefined,
      });

      return { providerMessageId: info.messageId ?? null };
    } catch (error) {
      // Nodemailer surfaces the SMTP reply code, and the first digit carries the
      // retry semantics: 5xx is a permanent rejection, 4xx is "try later".
      // Trusting the server's own classification beats pattern-matching its
      // human-readable text.
      const code = (error as { responseCode?: number }).responseCode;
      if (typeof code === "number" && code >= 500 && code < 600) {
        throw new PermanentSendError(
          `${this.name} rejected permanently (${code}): ${(error as Error).message}`
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

// ---------------------------------------------------------------------------
// Sink — for load testing
// ---------------------------------------------------------------------------

/**
 * Accepts and discards everything, optionally simulating latency and failures.
 *
 * This exists so throughput can be measured honestly. Benchmarking against a
 * real provider measures *their* SMTP server, not this queue, and free tiers cap
 * out long before the queue does. Pointing the worker at a sink isolates the
 * part actually under test: claim rate, lock contention, retry behaviour.
 *
 * For an end-to-end test that still inspects real rendered mail, point
 * `SmtpProvider` at a local Mailpit instead -- it speaks real SMTP on
 * localhost:1025 and captures everything without delivering it.
 */
export class SinkProvider implements EmailProvider {
  readonly name = "sink";

  constructor(
    private options: { latencyMs?: number; failureRate?: number } = {}
  ) {}

  async send(): Promise<SendResult> {
    const { latencyMs = 0, failureRate = 0 } = this.options;

    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    if (failureRate > 0 && Math.random() < failureRate) {
      throw new Error("sink: simulated transient failure");
    }

    return { providerMessageId: `sink-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

type BreakerState = "closed" | "open" | "half_open";

/**
 * Per-provider circuit breaker.
 *
 * Without one, a provider that is down still receives every message: each send
 * waits out its full timeout before failing, so the workers spend all their
 * concurrency sitting on doomed sockets and the queue stops draining even for
 * providers that are healthy. The breaker converts that slow failure into an
 * instant one, which is what frees the worker to try the next provider.
 *
 *   closed    -- normal. Consecutive failures are counted.
 *   open      -- tripped. Sends fail immediately without a network call.
 *   half_open -- after the cooldown, exactly one probe is allowed through. It
 *                decides whether to close again or re-open.
 *
 * The half-open state is what stops recovery from becoming a second outage:
 * flipping straight from open to closed would release the entire backlog at a
 * provider that has only just come back up.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether a call may proceed right now. */
  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half_open";
        this.probeInFlight = false;
      } else {
        return false;
      }
    }

    // half_open: admit a single probe, and hold everyone else out until it
    // reports back. Letting the whole backlog through here is the mistake that
    // turns a recovering provider straight back into a failing one.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.probeInFlight = false;

    // A failed probe sends us straight back to open for another full cooldown,
    // rather than accumulating toward the threshold again.
    if (this.state === "half_open") {
      this.trip();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) this.trip();
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
  }

  get status(): BreakerState {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Provider pool
// ---------------------------------------------------------------------------

export class ProviderPool {
  private breakers = new Map<string, CircuitBreaker>();

  constructor(private providers: EmailProvider[]) {
    if (providers.length === 0) {
      throw new Error("ProviderPool requires at least one provider");
    }
    for (const provider of providers) {
      this.breakers.set(provider.name, new CircuitBreaker());
    }
  }

  /**
   * Sends through the first healthy provider, falling back in order.
   *
   * A `PermanentSendError` stops the cascade immediately: the message itself was
   * rejected, so trying a second provider would only produce the same rejection
   * while spending another provider's quota. Transient failures are what
   * failover is for.
   */
  async send(message: OutboundMessage): Promise<SendResult & { provider: string }> {
    const errors: string[] = [];

    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.name)!;

      if (!breaker.canAttempt()) {
        errors.push(`${provider.name}: circuit ${breaker.status}`);
        continue;
      }

      try {
        const result = await provider.send(message);
        breaker.recordSuccess();
        return { ...result, provider: provider.name };
      } catch (error) {
        if (error instanceof PermanentSendError) {
          // Not the provider's health -- the message is bad. Don't let it count
          // against the breaker, or a burst of malformed payloads would trip a
          // perfectly healthy provider offline.
          throw error;
        }

        breaker.recordFailure();
        errors.push(`${provider.name}: ${(error as Error).message}`);
      }
    }

    throw new Error(`all providers failed -- ${errors.join("; ")}`);
  }

  get health(): Record<string, string> {
    return Object.fromEntries(
      [...this.breakers.entries()].map(([name, breaker]) => [name, breaker.status])
    );
  }
}

// ---------------------------------------------------------------------------
// Construction from environment
// ---------------------------------------------------------------------------

/**
 * Builds the provider chain from environment variables.
 *
 * Order is significant: the first entry is primary, the rest are fallbacks.
 */
export function buildProviderPool(): ProviderPool {
  const providers: EmailProvider[] = [];

  if (process.env.SINK_PROVIDER === "true") {
    providers.push(
      new SinkProvider({
        latencyMs: Number(process.env.SINK_LATENCY_MS ?? 0),
        failureRate: Number(process.env.SINK_FAILURE_RATE ?? 0),
      })
    );
  }

  if (process.env.SMTP_HOST) {
    providers.push(
      new SmtpProvider({
        name: "smtp",
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === "true",
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS ?? 5),
      })
    );
  }

  // The existing Gmail credentials, reused as a last-resort fallback so the
  // platform has somewhere to send from before any new provider is configured.
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    providers.push(
      new SmtpProvider({
        name: "gmail",
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
        maxConnections: 3,
      })
    );
  }

  if (providers.length === 0) {
    throw new Error(
      "No email provider configured. Set SINK_PROVIDER=true for load testing, " +
        "SMTP_HOST for a real SMTP server, or GMAIL_USER/GMAIL_APP_PASSWORD."
    );
  }

  return new ProviderPool(providers);
}
