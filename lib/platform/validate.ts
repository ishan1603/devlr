/**
 * Request validation for the public send API.
 *
 * Pure and dependency-free so the rules can be unit tested without a server, a
 * database, or a network. Validation is the one place where a subtle mistake is
 * directly reachable by an untrusted caller, which makes it the part most worth
 * testing exhaustively.
 */

export interface SendRequest {
  to: string;
  from: string;
  subject: string;
  html: string | null;
  text: string | null;
  scheduledFor: Date | null;
  idempotencyKey: string | null;
}

export type ValidationResult =
  | { ok: true; value: SendRequest }
  | { ok: false; message: string };

/** Practical limits, chosen to reject abuse rather than to police formatting. */
const MAX_SUBJECT_LENGTH = 998; // RFC 5322 unfolded line limit.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_ADDRESS_LENGTH = 320; // 64-char local part + "@" + 255-char domain.

/**
 * Deliberately permissive address check.
 *
 * Full RFC 5322 validation is a well-known dead end -- the grammar admits
 * quoted strings, comments and nested folding that no sane sender uses, and
 * every "correct" regex for it is famously unreadable and still wrong. Worse,
 * strict validation rejects real, deliverable addresses, which is a far more
 * expensive error than accepting an undeliverable one.
 *
 * So this checks only the structural minimum. The authoritative validation of an
 * email address is whether it bounces, and the suppression list is what records
 * that answer.
 */
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Rejects CR and LF anywhere in a value destined for an email header.
 *
 * This is the security check in this file, not a formatting nicety. SMTP
 * separates headers with CRLF, so a subject of
 *
 *     "Hi\r\nBcc: everyone@example.com"
 *
 * becomes a real Bcc header the moment it is serialised. That is header
 * injection, and it turns a send API into an open relay for whoever can reach
 * it. The same applies to any caller-supplied address field.
 *
 * Rejecting outright rather than stripping: a caller sending newlines in a
 * subject line has a bug, and silently rewriting their payload hides it.
 */
function containsHeaderInjection(value: string): boolean {
  return /[\r\n]/.test(value);
}

/**
 * Validates one address field.
 *
 * Split out rather than looped over both fields so that a successful result
 * carries a non-null `string` the compiler can see -- narrowing does not survive
 * a loop, and the alternative is a non-null assertion that would silently outlive
 * any future change to these checks.
 */
function validateAddress(
  field: string,
  value: string | null
): { ok: true; value: string } | { ok: false; message: string } {
  if (!value) return { ok: false, message: `"${field}" is required.` };

  if (value.length > MAX_ADDRESS_LENGTH) {
    return { ok: false, message: `"${field}" exceeds ${MAX_ADDRESS_LENGTH} characters.` };
  }
  if (containsHeaderInjection(value)) {
    return { ok: false, message: `"${field}" must not contain line breaks.` };
  }
  if (!ADDRESS_PATTERN.test(value)) {
    return { ok: false, message: `"${field}" is not a valid email address.` };
  }

  return { ok: true, value };
}

function asString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function validateSendRequest(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const source = body as Record<string, unknown>;

  // --- Addresses ----------------------------------------------------------
  const toResult = validateAddress("to", asString(source, "to"));
  if (!toResult.ok) return toResult;

  const fromResult = validateAddress("from", asString(source, "from"));
  if (!fromResult.ok) return fromResult;

  const to = toResult.value;
  const from = fromResult.value;

  // --- Subject ------------------------------------------------------------
  const subject = asString(source, "subject");
  if (!subject) return { ok: false, message: `"subject" is required.` };
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, message: `"subject" exceeds ${MAX_SUBJECT_LENGTH} characters.` };
  }
  if (containsHeaderInjection(subject)) {
    return { ok: false, message: `"subject" must not contain line breaks.` };
  }

  // --- Body ---------------------------------------------------------------
  const html = asString(source, "html");
  const text = asString(source, "text");

  if (!html && !text) {
    return { ok: false, message: `At least one of "html" or "text" is required.` };
  }

  for (const [field, value] of [
    ["html", html],
    ["text", text],
  ] as const) {
    // Byte length, not character length: a body of astral-plane characters is
    // twice the size that `.length` reports, and the limit exists to bound
    // memory and payload size rather than to count glyphs.
    if (value && Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
      return { ok: false, message: `"${field}" exceeds ${MAX_BODY_BYTES} bytes.` };
    }
  }

  // --- Scheduling ---------------------------------------------------------
  let scheduledFor: Date | null = null;
  const rawSchedule = source["scheduled_for"] ?? source["scheduledFor"];

  if (rawSchedule !== undefined && rawSchedule !== null) {
    if (typeof rawSchedule !== "string") {
      return { ok: false, message: `"scheduled_for" must be an ISO 8601 string.` };
    }

    const parsed = new Date(rawSchedule);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, message: `"scheduled_for" is not a valid ISO 8601 timestamp.` };
    }

    // A past timestamp is accepted and means "send now" -- clock skew between
    // the caller and us is real, and rejecting a send because the client's clock
    // is four seconds fast would be a hostile way to surface that.
    const maxHorizon = Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (parsed.getTime() > maxHorizon) {
      return { ok: false, message: `"scheduled_for" must be within one year.` };
    }

    scheduledFor = parsed;
  }

  // --- Idempotency --------------------------------------------------------
  const idempotencyKey = asString(source, "idempotency_key") ?? asString(source, "idempotencyKey");

  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      ok: false,
      message: `"idempotency_key" exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    };
  }

  return {
    ok: true,
    value: { to, from, subject, html, text, scheduledFor, idempotencyKey },
  };
}
