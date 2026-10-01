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
/** Rows per request. Supabase caps any single response at 1,000 by default. */
const PAGE_SIZE = 1000;

/**
 * Read every row a query matches, not just the first page.
 *
 * Supabase silently truncates a response at 1,000 rows: no error, no flag,
 * just fewer rows than exist. For a list on a screen that is fine. For "every
 * reader who is due an email" it means the 1,001st reader never hears from us
 * again, and nothing anywhere says why. Anything that must see the whole set
 * goes through this.
 *
 * `build` receives the inclusive row range for one page and must apply a
 * stable order, or pages can overlap and skip.
 */
export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Background jobs cannot read or write without the service-role key."
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
