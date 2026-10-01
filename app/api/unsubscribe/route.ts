import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Token-based unsubscribe. No login required: a reader who has lost access to
 * their account must still be able to stop the mail, and mailbox providers
 * weigh a working unsubscribe heavily when deciding whether to deliver to the
 * inbox.
 *
 * Two kinds of token. A profile token pauses everything. A subscription token
 * switches off one module, so someone can stop Learn and keep security alerts.
 *
 * The service-role client is correct here precisely because there is no
 * session: the unguessable token is the authorisation.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function unsubscribeByToken(token: string): Promise<{ scope: "all" | "module"; module?: string } | null> {
  // Checked first so a malformed token is a clean 404 rather than a Postgres
  // "invalid input syntax for type uuid" error.
  if (!UUID.test(token)) return null;
  const supabase = createAdminClient();

  const { data: profile, error } = await supabase
    .from("profiles")
    .update({ is_paused: true })
    .eq("unsubscribe_token", token)
    .select("user_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (profile) return { scope: "all" };

  const { data: subscription, error: subError } = await supabase
    .from("subscriptions")
    .update({ is_active: false })
    .eq("unsubscribe_token", token)
    .select("module")
    .maybeSingle();
  if (subError) throw new Error(subError.message);
  if (subscription) return { scope: "module", module: subscription.module as string };

  return null;
}

/**
 * One-click unsubscribe, per RFC 8058.
 *
 * Gmail and Yahoo require bulk senders to honour a POST to the
 * List-Unsubscribe URL without any further interaction. The provider, not the
 * reader, sends this request.
 */
export async function POST(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

  try {
    const result = await unsubscribeByToken(token);
    if (!result) return NextResponse.json({ error: "Unknown token" }, { status: 404 });
    return NextResponse.json({ success: true, ...result });
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
