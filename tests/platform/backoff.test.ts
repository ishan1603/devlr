import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  backoffDelayMs,
  nextRunAfter,
  isExhausted,
  classifyFailure,
} from "@/lib/platform/backoff";

describe("backoffDelayMs", () => {
  test("grows exponentially in its ceiling", () => {
    // random() === 1 would exceed the ceiling, so the max observable delay uses
    // a value just under it. Comparing ceilings across attempts is the property
    // that actually matters.
    const atMax = (attempts: number) => backoffDelayMs(attempts, () => 0.999999);

    assert.ok(atMax(1) < atMax(2), "attempt 2 should allow a longer delay than 1");
    assert.ok(atMax(2) < atMax(3), "attempt 3 should allow a longer delay than 2");
    assert.ok(atMax(3) < atMax(4), "attempt 4 should allow a longer delay than 3");
  });

  test("first retry is bounded by the 2s base", () => {
    assert.ok(backoffDelayMs(1, () => 0.999999) <= 2_000);
  });

  test("never exceeds the one hour cap, however many attempts", () => {
    for (const attempts of [10, 25, 50, 1_000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffDelayMs(attempts, () => 0.999999);
      assert.ok(Number.isFinite(delay), `attempt ${attempts} produced ${delay}`);
      assert.ok(delay <= 3_600_000, `attempt ${attempts} exceeded the cap: ${delay}`);
    }
  });

  test("full jitter can return zero", () => {
    assert.equal(backoffDelayMs(5, () => 0), 0);
  });

  test("jitter spreads retries rather than synchronising them", () => {
    // The property the jitter exists for: identical jobs failing at the same
    // instant must not all come back at the same instant.
    const delays = new Set(
      Array.from({ length: 200 }, () => backoffDelayMs(6))
    );
    assert.ok(delays.size > 100, `expected a wide spread, got ${delays.size} distinct values`);
  });

  test("clamps nonsensical attempt counts instead of returning zero or NaN", () => {
    for (const attempts of [0, -1, -100, 0.5]) {
      const delay = backoffDelayMs(attempts, () => 0.5);
      assert.ok(Number.isFinite(delay) && delay >= 0, `attempts=${attempts} gave ${delay}`);
    }
  });
});

describe("nextRunAfter", () => {
  test("returns a time at or after now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = nextRunAfter(3, now, () => 0.5);
    assert.ok(result.getTime() >= now.getTime());
  });

  test("is deterministic when randomness is injected", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const a = nextRunAfter(4, now, () => 0.25);
    const b = nextRunAfter(4, now, () => 0.25);
    assert.equal(a.getTime(), b.getTime());
  });
});

describe("isExhausted", () => {
  test("the attempt that reaches the limit is terminal", () => {
    // attempts is incremented at claim time, so the 5th failure arrives here as
    // attempts === 5 and must not be retried a 6th time.
    assert.equal(isExhausted(5, 5), true);
    assert.equal(isExhausted(4, 5), false);
    assert.equal(isExhausted(6, 5), true);
  });
});

describe("classifyFailure", () => {
  test("5xx is transient", () => {
    assert.equal(classifyFailure(500, "internal error"), "transient");
    assert.equal(classifyFailure(503, "unavailable"), "transient");
  });

  test("429 is transient despite being 4xx", () => {
    assert.equal(classifyFailure(429, "too many requests"), "transient");
  });

  test("other 4xx is permanent", () => {
    assert.equal(classifyFailure(400, "bad request"), "permanent");
    assert.equal(classifyFailure(422, "invalid recipient"), "permanent");
  });

  test("network errors with no status code are transient", () => {
    assert.equal(classifyFailure(undefined, "ETIMEDOUT"), "transient");
    assert.equal(classifyFailure(undefined, "ECONNRESET while reading"), "transient");
    assert.equal(classifyFailure(undefined, "getaddrinfo ENOTFOUND smtp.example.com"), "transient");
    assert.equal(classifyFailure(undefined, "socket hang up"), "transient");
  });

  test("an unrecognised error with no status code is treated as transient", () => {
    // Erring toward retry: wrongly retrying costs an attempt, wrongly giving up
    // loses a message the caller believed was accepted.
    assert.equal(classifyFailure(undefined, "something unexpected"), "transient");
  });
});
