import { createAdminClient } from "@/lib/supabase-admin";
import { hashApiKey, looksLikeApiKey, parseAuthorizationHeader } from "@/lib/platform/keys";

/**
 * API key authentication for the public platform API.
 *
 * Deliberately separate from `lib/server.ts`, which authenticates a *person* via
 * a Supabase session cookie. Callers of this API are machines: no cookies, no
 * `auth.uid()`, and a credential that must survive being pasted into someone
 * else's backend config.
 */

export interface AuthenticatedTenant {
  tenantId: string;
  name: string;
  apiKeyId: string;
  rateLimitPerSec: number;
  dailyQuota: number;
}

export type AuthFailure =
  | "missing_credentials"
  | "malformed_key"
  | "invalid_key"
  | "revoked_key";

export type AuthResult =
  | { ok: true; tenant: AuthenticatedTenant }
  | { ok: false; reason: AuthFailure };

/**
 * Resolves an Authorization header to a tenant.
 *
 * The lookup is by SHA-256 hash against a unique index, so it is a single index
 * probe regardless of how many keys exist, and the stored value is useless to
 * anyone who reads the table.
 *
 * Every failure mode returns the same 401 to the caller. The distinction in
 * `reason` exists for our logs, not for the response body: telling an attacker
 * that a key is "revoked" rather than "invalid" confirms the key was once real,
 * which is a small but free piece of intelligence.
 */
export async function authenticateRequest(request: Request): Promise<AuthResult> {
  const raw = parseAuthorizationHeader(request.headers.get("authorization"));

  if (!raw) return { ok: false, reason: "missing_credentials" };
  if (!looksLikeApiKey(raw)) return { ok: false, reason: "malformed_key" };

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("platform_api_keys")
    .select(
      "id, tenant_id, revoked_at, platform_tenants ( id, name, rate_limit_per_sec, daily_quota )"
    )
    .eq("key_hash", hashApiKey(raw))
    .maybeSingle();

  if (error) throw new Error(`api key lookup failed: ${error.message}`);
  if (!data) return { ok: false, reason: "invalid_key" };
  if (data.revoked_at) return { ok: false, reason: "revoked_key" };

  // supabase-js types an embedded to-one relation as possibly an array; the FK
  // makes it single-valued in practice.
  const tenantRow = Array.isArray(data.platform_tenants)
    ? data.platform_tenants[0]
    : data.platform_tenants;

  if (!tenantRow) return { ok: false, reason: "invalid_key" };

  // Fire-and-forget: `last_used_at` is for the tenant's own "is this key still
  // in use?" question, and blocking every authenticated request on a write --
  // one write per request, on the hot path -- to maintain it is not a trade
  // worth making. A lost update here costs nothing.
  void supabase
    .from("platform_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(({ error: updateError }) => {
      if (updateError) console.warn("last_used_at update failed:", updateError.message);
    });

  return {
    ok: true,
    tenant: {
      tenantId: tenantRow.id,
      name: tenantRow.name,
      apiKeyId: data.id,
      rateLimitPerSec: tenantRow.rate_limit_per_sec,
      dailyQuota: tenantRow.daily_quota,
    },
  };
}
