import { NextResponse } from "next/server";
import { createClient } from "@/lib/server";

/**
 * The signed-in user's send history.
 *
 * Uses the cookie-scoped client on purpose: the "own sends: select" RLS policy
 * does the ownership filtering, so there is no way for a bug here to leak
 * another user's history.
 */
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("newsletter_sends")
    .select("id, send_kind, status, article_count, error, created_at, sent_at, categories")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("Error fetching send history:", error);
    return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
  }

  return NextResponse.json({ sends: data ?? [] });
}
