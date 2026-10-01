import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateSendRequest } from "@/lib/platform/validate";

const valid = {
  to: "reader@example.com",
  from: "briefing@sendlr.dev",
  subject: "Your Tuesday briefing",
  text: "Three stories today.",
};

function expectRejection(body: unknown, fragment: string) {
  const result = validateSendRequest(body);
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(body)}`);
  if (!result.ok) {
    assert.match(result.message, new RegExp(fragment, "i"));
  }
}

describe("validateSendRequest — happy path", () => {
  test("accepts a minimal valid request", () => {
    const result = validateSendRequest(valid);
    assert.equal(result.ok, true);
  });

  test("accepts html only", () => {
    const result = validateSendRequest({ ...valid, text: undefined, html: "<p>hi</p>" });
    assert.equal(result.ok, true);
  });

  test("normalises absent optional fields to null rather than undefined", () => {
    const result = validateSendRequest(valid);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.html, null);
      assert.equal(result.value.scheduledFor, null);
      assert.equal(result.value.idempotencyKey, null);
    }
  });

  test("accepts both snake_case and camelCase for optional fields", () => {
    const snake = validateSendRequest({ ...valid, idempotency_key: "abc", scheduled_for: "2026-10-01T09:00:00Z" });
    const camel = validateSendRequest({ ...valid, idempotencyKey: "abc", scheduledFor: "2026-10-01T09:00:00Z" });

    assert.equal(snake.ok, true);
    assert.equal(camel.ok, true);
    if (snake.ok && camel.ok) {
      assert.equal(snake.value.idempotencyKey, "abc");
      assert.equal(camel.value.idempotencyKey, "abc");
    }
  });
});

describe("validateSendRequest — header injection", () => {
  // The security-critical cases. A newline that survives into a header turns
  // this API into an open relay.
  test("rejects a newline in the subject", () => {
    expectRejection(
      { ...valid, subject: "Hello\r\nBcc: everyone@example.com" },
      "line breaks"
    );
  });

  test("rejects a bare LF in the subject", () => {
    expectRejection({ ...valid, subject: "Hello\nBcc: victim@example.com" }, "line breaks");
  });

  test("rejects a newline in the to address", () => {
    expectRejection({ ...valid, to: "a@example.com\r\nBcc: b@example.com" }, "line breaks");
  });

  test("rejects a newline in the from address", () => {
    expectRejection({ ...valid, from: "a@example.com\nFrom: spoofed@bank.example" }, "line breaks");
  });

  test("a newline in the body is fine — bodies are not headers", () => {
    const result = validateSendRequest({ ...valid, text: "line one\nline two" });
    assert.equal(result.ok, true);
  });
});

describe("validateSendRequest — addresses", () => {
  test("requires to and from", () => {
    expectRejection({ ...valid, to: undefined }, "to");
    expectRejection({ ...valid, from: undefined }, "from");
  });

  test("rejects structurally invalid addresses", () => {
    for (const bad of ["notanemail", "no@domain", "@example.com", "a b@example.com", "a@@b.com"]) {
      expectRejection({ ...valid, to: bad }, "valid email");
    }
  });

  test("accepts the awkward-but-real addresses strict validators break on", () => {
    for (const good of [
      "user+tag@example.com",
      "first.last@sub.example.co.uk",
      "user_name@example-host.org",
      "123@example.com",
    ]) {
      const result = validateSendRequest({ ...valid, to: good });
      assert.equal(result.ok, true, `should have accepted ${good}`);
    }
  });

  test("rejects an absurdly long address", () => {
    expectRejection({ ...valid, to: `${"a".repeat(400)}@example.com` }, "exceeds");
  });
});

describe("validateSendRequest — body and subject", () => {
  test("requires a subject", () => {
    expectRejection({ ...valid, subject: undefined }, "subject");
    expectRejection({ ...valid, subject: "   " }, "subject");
  });

  test("requires at least one body", () => {
    expectRejection({ ...valid, text: undefined, html: undefined }, "html.*text");
  });

  test("rejects an over-long subject", () => {
    expectRejection({ ...valid, subject: "x".repeat(1_500) }, "exceeds");
  });
});

describe("validateSendRequest — scheduling", () => {
  test("rejects an unparseable timestamp", () => {
    expectRejection({ ...valid, scheduled_for: "next tuesday" }, "ISO 8601");
  });

  test("rejects a non-string timestamp", () => {
    expectRejection({ ...valid, scheduled_for: 1234567890 }, "ISO 8601");
  });

  test("accepts a past timestamp as send-now, tolerating clock skew", () => {
    const result = validateSendRequest({ ...valid, scheduled_for: "2020-01-01T00:00:00Z" });
    assert.equal(result.ok, true);
  });

  test("rejects a timestamp beyond the one year horizon", () => {
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    expectRejection({ ...valid, scheduled_for: farFuture }, "within one year");
  });
});

describe("validateSendRequest — malformed input", () => {
  test("rejects non-objects", () => {
    for (const bad of [null, "string", 42, true, []]) {
      expectRejection(bad, "JSON object");
    }
  });

  test("rejects non-string fields without throwing", () => {
    // Reached directly by untrusted callers, so a type confusion here must be a
    // 422 and never a 500.
    assert.doesNotThrow(() => validateSendRequest({ ...valid, to: { $ne: null } }));
    assert.doesNotThrow(() => validateSendRequest({ ...valid, subject: ["a", "b"] }));
    assert.doesNotThrow(() => validateSendRequest({ ...valid, html: 12345 }));
  });
});
