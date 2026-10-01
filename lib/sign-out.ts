/**
 * Sign the current user out.
 *
 * The Supabase client is imported here, at the moment it is needed, rather
 * than at the top of the file. It is about 67 KB gzipped, and the only thing
 * the app shell uses it for is this one button. Importing it normally would
 * put it in the first load of every signed-in page (and, when it lived in a
 * provider in the root layout, of the landing page too).
 */
export async function signOut(): Promise<void> {
  const { createClient } = await import("@/lib/client");
  await createClient().auth.signOut();
}
