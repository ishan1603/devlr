import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client, for trusted server-side contexts only.
 *
 * `lib/server.ts` builds a cookie-scoped client: it carries the signed-in user's
 * JWT, so RLS resolves `auth.uid()` and each request sees only its own row. That
 * is the right client for API routes.
 *
 * Background jobs have no cookies. Under RLS an anonymous client resolves
 * `auth.uid()` to null and every query comes back empty, which the Inngest
 * function would misread as "user has no preferences" and cancel the send. Those
 * jobs legitimately need to read other users' rows, so they use this client,
 * which bypasses RLS entirely.
 *
 * Never import this from a Client Component or any browser-reachable path — the
 * key it carries can read and write every row in the database.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Background newsletter jobs cannot read preferences without the service-role key."
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
