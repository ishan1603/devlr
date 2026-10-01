import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/platform/auth";
import { enqueueMessage } from "@/lib/platform/queue";
import { validateSendRequest } from "@/lib/platform/validate";

/**
 * POST /api/v1/messages — accept a message for delivery.
 *
 * The public entry point to the platform. It authenticates by API key, validates
 * the payload, and enqueues; it never talks to an email provider itself. That
 * separation is the whole point of the queue: accepting a message is a database
 * write measured in milliseconds, while delivering it depends on a third party
 * that may be slow, rate limited, or down. Callers get a fast, reliable 202 and
 * the delivery happens behind it.
 */

// node:crypto, used for API key hashing, is unavailable on the Edge runtime.
export const runtime = "nodejs";

interface ApiError {
  code: string;
  message: string;
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json<{ error: ApiError }>({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  // --- Authenticate -------------------------------------------------------
  let auth;
  try {
    auth = await authenticateRequest(request);
  } catch (error) {
    console.error("auth lookup failed:", error);
    return errorResponse(503, "auth_unavailable", "Could not verify credentials. Retry shortly.");
  }

  if (!auth.ok) {
    // One response for every authentication failure; the specific reason goes to
    // the log, not to the caller. See lib/platform/auth.ts.
    console.warn("rejected API request:", auth.reason);
    return errorResponse(401, "unauthorized", "Invalid or missing API key.");
  }

  // --- Parse --------------------------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  const validation = validateSendRequest(body);
  if (!validation.ok) {
    return errorResponse(422, "validation_failed", validation.message);
  }

  const payload = validation.value;

  // An idempotency key may arrive in the header (the convention Stripe set) or
  // in the body. The header wins when both are present, because that is the one
  // an HTTP client library will set automatically on a retry.
  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() || payload.idempotencyKey || null;

  // --- Enqueue ------------------------------------------------------------
  try {
    const result = await enqueueMessage({
      tenantId: auth.tenant.tenantId,
      idempotencyKey,
      to: payload.to,
      from: payload.from,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      scheduledFor: payload.scheduledFor,
    });

    // A replay returns 200 and the original message rather than 202, so a client
    // can tell that its retry was absorbed rather than creating a second send.
    const status = result.created ? 202 : 200;

    return NextResponse.json(
      {
        id: result.messageId,
        status: result.status,
        // Surfaced explicitly: a caller reconciling its own records needs to
        // know this was a duplicate, and inferring it from the status code is
        // fragile through proxies and SDK wrappers.
        idempotent_replay: !result.created,
      },
      {
        status,
        headers: result.created ? undefined : { "Idempotent-Replay": "true" },
      }
    );
  } catch (error) {
    console.error("enqueue failed:", error);
    return errorResponse(503, "enqueue_failed", "Could not accept the message. Retry shortly.");
  }
}
