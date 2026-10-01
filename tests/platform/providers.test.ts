import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CircuitBreaker,
  ProviderPool,
  PermanentSendError,
  type EmailProvider,
  type OutboundMessage,
  type SendResult,
} from "@/lib/platform/providers";

/** A controllable stand-in, so the pool can be tested without a network. */
class FakeProvider implements EmailProvider {
  sendCount = 0;

  constructor(
    readonly name: string,
    private behaviour: () => Promise<SendResult>
  ) {}

  async send(_message: OutboundMessage): Promise<SendResult> {
    this.sendCount += 1;
    return this.behaviour();
  }
}

const ok = () => Promise.resolve({ providerMessageId: "ok" });
const transient = () => Promise.reject(new Error("connection reset"));
const permanent = () => Promise.reject(new PermanentSendError("550 no such mailbox"));

const message: OutboundMessage = {
  to: "a@example.com",
  from: "b@example.com",
  subject: "hi",
  html: null,
  text: "hi",
};

describe("CircuitBreaker", () => {
  test("starts closed and admits calls", () => {
    const breaker = new CircuitBreaker();
    assert.equal(breaker.status, "closed");
    assert.equal(breaker.canAttempt(), true);
  });

  test("trips open after the threshold of consecutive failures", () => {
    const breaker = new CircuitBreaker(3, 30_000);

    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.status, "closed", "should still be closed below the threshold");

    breaker.recordFailure();
    assert.equal(breaker.status, "open");
    assert.equal(breaker.canAttempt(), false, "an open breaker must reject immediately");
  });

  test("a success resets the failure count", () => {
    const breaker = new CircuitBreaker(3, 30_000);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();

    assert.equal(breaker.status, "closed", "intermittent failures must not accumulate to a trip");
  });

  test("moves to half-open after the cooldown and admits exactly one probe", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(1, 5_000, () => now);

    breaker.recordFailure();
    assert.equal(breaker.canAttempt(), false);

    now += 5_000;

    assert.equal(breaker.canAttempt(), true, "first call after cooldown is the probe");
    assert.equal(breaker.status, "half_open");
    assert.equal(breaker.canAttempt(), false, "the backlog must be held out behind the probe");
  });

  test("a failed probe re-opens for a full cooldown", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(1, 5_000, () => now);

    breaker.recordFailure();
    now += 5_000;
    breaker.canAttempt();
    breaker.recordFailure();

    assert.equal(breaker.status, "open");
    assert.equal(breaker.canAttempt(), false, "should not immediately re-probe");

    now += 5_000;
    assert.equal(breaker.canAttempt(), true);
  });

  test("a successful probe closes the breaker", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(1, 5_000, () => now);

    breaker.recordFailure();
    now += 5_000;
    breaker.canAttempt();
    breaker.recordSuccess();

    assert.equal(breaker.status, "closed");
    assert.equal(breaker.canAttempt(), true);
  });
});

describe("ProviderPool", () => {
  test("uses the primary when it is healthy", async () => {
    const primary = new FakeProvider("primary", ok);
    const fallback = new FakeProvider("fallback", ok);

    const result = await new ProviderPool([primary, fallback]).send(message);

    assert.equal(result.provider, "primary");
    assert.equal(fallback.sendCount, 0, "fallback must not be touched when primary works");
  });

  test("falls over to the next provider on a transient failure", async () => {
    const primary = new FakeProvider("primary", transient);
    const fallback = new FakeProvider("fallback", ok);

    const result = await new ProviderPool([primary, fallback]).send(message);

    assert.equal(result.provider, "fallback");
    assert.equal(primary.sendCount, 1);
  });

  test("a permanent rejection stops the cascade", async () => {
    // The message is bad, not the provider. Trying everyone else would produce
    // the same rejection while spending each one's quota.
    const primary = new FakeProvider("primary", permanent);
    const fallback = new FakeProvider("fallback", ok);

    await assert.rejects(
      () => new ProviderPool([primary, fallback]).send(message),
      PermanentSendError
    );

    assert.equal(fallback.sendCount, 0, "must not try the fallback for a bad message");
  });

  test("a permanent rejection does not trip the breaker", async () => {
    const primary = new FakeProvider("primary", permanent);
    const pool = new ProviderPool([primary]);

    // Well past the default threshold of 5.
    for (let i = 0; i < 10; i++) {
      await assert.rejects(() => pool.send(message));
    }

    assert.equal(
      pool.health.primary,
      "closed",
      "a burst of malformed payloads must not take a healthy provider offline"
    );
  });

  test("throws when every provider fails, naming each failure", async () => {
    const pool = new ProviderPool([
      new FakeProvider("a", transient),
      new FakeProvider("b", transient),
    ]);

    await assert.rejects(
      () => pool.send(message),
      (error: Error) => {
        assert.match(error.message, /all providers failed/);
        assert.match(error.message, /a:/);
        assert.match(error.message, /b:/);
        return true;
      }
    );
  });

  test("stops calling a provider once its breaker opens", async () => {
    const primary = new FakeProvider("primary", transient);
    const fallback = new FakeProvider("fallback", ok);
    const pool = new ProviderPool([primary, fallback]);

    // Default threshold is 5 consecutive failures.
    for (let i = 0; i < 5; i++) await pool.send(message);
    const countAtTrip = primary.sendCount;

    await pool.send(message);

    assert.equal(primary.sendCount, countAtTrip, "open breaker must short-circuit the call");
    assert.equal(pool.health.primary, "open");
  });

  test("refuses to construct with no providers", () => {
    assert.throws(() => new ProviderPool([]), /at least one provider/);
  });
});
