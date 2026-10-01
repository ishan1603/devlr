import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed links for actions taken from inside an email.
 *
 * A reader clicking "less like this" has no session, and asking them to sign in
 * first means nobody would ever click it. So the link itself carries who, what
 * and which way, plus an HMAC that proves we issued it. Nothing is stored until
 * the link is used.
 */

function secret(): string {
  // A dedicated secret is preferred. Deriving one from the service-role key
  // means the feature works with zero extra configuration, and that key is
  // already the most sensitive value in the environment.
  const base = process.env.APP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error("APP_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set to sign links.");
  return base;
}

function sign(payload: string): string {
  return createHmac("sha256", `devlr-links:${secret()}`).update(payload).digest("base64url").slice(0, 32);
}

export type FeedbackSignal = 1 | -1;

export interface FeedbackClaim {
  userId: string;
  ref: string;
  signal: FeedbackSignal;
}

/** `<userId>.<ref>.<m|l>.<signature>`: short enough to survive any mail client. */
export function signFeedback(claim: FeedbackClaim): string {
  const payload = `${claim.userId}.${claim.ref}.${claim.signal === 1 ? "m" : "l"}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyFeedback(token: string): FeedbackClaim | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, ref, direction, signature] = parts;
  if (direction !== "m" && direction !== "l") return null;

  const expected = sign(`${userId}.${ref}.${direction}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a mismatch rather than returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { userId, ref, signal: direction === "m" ? 1 : -1 };
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function feedbackLinks(userId: string, ref: string): { more: string; less: string } {
  const base = appUrl();
  return {
    more: `${base}/f/${signFeedback({ userId, ref, signal: 1 })}`,
    less: `${base}/f/${signFeedback({ userId, ref, signal: -1 })}`,
  };
}
