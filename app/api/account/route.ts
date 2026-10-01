import { NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Delete the signed-in account and everything attached to it.
 *
 * Every user table references auth.users with ON DELETE CASCADE, so removing
 * the auth user removes the profile, subscriptions, history and feedback in
 * one statement. Nothing is soft-deleted.
 */
export async function DELETE() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { error } = await createAdminClient().auth.admin.deleteUser(user.id);
  if (error) {
    console.error("account deletion failed:", error.message);
    return NextResponse.json({ error: "Could not delete the account." }, { status: 500 });
  }

  await supabase.auth.signOut();
  return NextResponse.json({ deleted: true });
}
