import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Token-based unsubscribe. No login required — a reader who has lost access to
 * their account must still be able to stop the mail, and mailbox providers weigh
 * a working unsubscribe heavily when deciding whether to deliver to the inbox.
 *
 * The service-role client is correct here precisely because there is no session:
 * the unguessable token is the authorisation.
 */
async function unsubscribeByToken(token: string) {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("user_preferences")
    .update({ is_active: false })
    .eq("unsubscribe_token", token)
    .select("email")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * One-click unsubscribe, per RFC 8058.
 *
 * Gmail and Yahoo require bulk senders to honour a POST to the
 * List-Unsubscribe URL without any further interaction. The provider — not the
 * reader — sends this request.
 */
export async function POST(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  try {
    const row = await unsubscribeByToken(token);
    if (!row) return NextResponse.json({ error: "Unknown token" }, { status: 404 });
    return NextResponse.json({ success: true, email: row.email });
  } catch (err) {
    console.error("Unsubscribe failed:", err);
    return NextResponse.json({ error: "Unsubscribe failed" }, { status: 500 });
  }
}

/**
 * A human clicking the footer link lands here.
 *
 * This deliberately does NOT unsubscribe. Mailbox scanners and link previewers
 * issue GETs against every URL in a message, so acting on GET would silently
 * unsubscribe readers who never clicked anything. It hands off to a page with a
 * button instead.
 */
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  return NextResponse.redirect(`${base}/unsubscribe?token=${encodeURIComponent(token)}`);
}
