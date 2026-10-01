import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API key minting and verification.
 *
 * Anything importing this must run on the Node runtime, not Edge -- `node:crypto`
 * is unavailable there. Route handlers that authenticate a key therefore declare
 * `export const runtime = "nodejs"`.
 */

const KEY_PREFIX = "sk_live_";

/** Characters of the raw key retained in the clear for display. */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8;

export interface GeneratedKey {
  /** The full secret. Shown to the caller once and never stored. */
  raw: string;
  /** Non-secret leading fragment, safe to display in a key list. */
  prefix: string;
  /** What actually goes in the database. */
  hash: string;
}

/**
 * Mints a new API key.
 *
 * 32 bytes from the CSPRNG, base64url encoded. That is 256 bits of entropy,
 * which puts brute force beyond reach and means the key needs no rate limiting
 * of its own to be safe against guessing -- the rate limiting that does exist is
 * about protecting the provider's quota, not the key.
 *
 * `randomBytes` rather than `Math.random`: the latter is seeded from the clock
 * and entirely predictable, which has produced real, exploitable token
 * generation bugs.
 */
export function generateApiKey(): GeneratedKey {
  const raw = KEY_PREFIX + randomBytes(32).toString("base64url");

  return {
    raw,
    prefix: raw.slice(0, DISPLAY_PREFIX_LENGTH),
    hash: hashApiKey(raw),
  };
}

/**
 * Hashes a key for storage and lookup.
 *
 * Plain SHA-256, deliberately, where a *password* would demand bcrypt or argon2.
 * The reason the usual advice is inverted here: slow hashes exist to frustrate
 * offline brute force of low-entropy human-chosen secrets. This input is 256
 * random bits, so there is nothing to brute force, and a deliberately slow hash
 * would instead add latency to every single API request while buying no
 * security. Fast and deterministic is also what lets the hash be a unique index.
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * Returns null rather than throwing: a malformed header is an ordinary 401, not
 * an exceptional condition, and throwing here would turn a hostile request into
 * a 500 and a log entry.
 */
export function parseAuthorizationHeader(header: string | null): string | null {
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Cheap structural check, used to reject junk before it reaches the database. */
export function looksLikeApiKey(candidate: string): boolean {
  return candidate.startsWith(KEY_PREFIX) && candidate.length >= DISPLAY_PREFIX_LENGTH;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The database lookup is by hash and therefore already the equality test, so
 * this is not on the authentication path today. It is here for any code that
 * compares a *provider* webhook signature, where the compared value genuinely is
 * attacker-influenced and an early-exit `===` leaks the matching prefix length
 * one byte at a time.
 */
export function secureEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal; comparing lengths first and returning the same way for every
  // mismatched pair keeps the leak to "lengths differ", which is not secret.
  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}
