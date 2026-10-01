import { NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { EVENTS, inngest, type SendIssueEvent } from "@/lib/inngest/client";
import { buildDedupeKey, manualSlot } from "@/lib/delivery/ledger";

/**
 * "Send me one now."
 *
 * Only queues the send. Building an issue takes several seconds and can retry,
 * so it belongs in a background job, not in a request someone is waiting on.
 * The dedupe key is bucketed to the minute, so a double click is one email.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarded_at, is_paused")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile?.onboarded_at) {
    return NextResponse.json({ error: "Finish setting up first." }, { status: 409 });
  }
  if (profile.is_paused) {
    return NextResponse.json({ error: "Email is paused. Resume it in settings to send." }, { status: 409 });
  }

  const dedupeKey = buildDedupeKey("manual", user.id, manualSlot());
  try {
    await inngest.send({
      name: EVENTS.sendIssue,
      data: { userId: user.id, kind: "manual", modules: [], dedupeKey } satisfies SendIssueEvent,
    });
  } catch (err) {
    console.error("send-now: could not queue the send:", err);
    return NextResponse.json(
      { error: "Could not queue the send. Is the Inngest dev server running?" },
      { status: 503 }
    );
  }

  return NextResponse.json({ queued: true });
}
