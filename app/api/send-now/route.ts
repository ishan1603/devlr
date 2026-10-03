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
export async function POST(request: Request) {
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

  const body = await request.json().catch(() => ({}));
  let requestedModules = Array.isArray(body.modules) ? body.modules : [];

  try {
    if (requestedModules.length === 0) {
      // Fetch all active subscriptions for the user
      const { data: subs } = await supabase
        .from("user_subscriptions")
        .select("module")
        .eq("user_id", user.id)
        .eq("paused", false);
      
      requestedModules = subs?.map(s => s.module) || [];
    }

    if (requestedModules.length === 0) {
      return NextResponse.json({ error: "No active modules to send." }, { status: 400 });
    }

    // Dispatch separate events for each module
    await inngest.send(
      requestedModules.map((module: string) => ({
        name: EVENTS.sendIssue,
        data: { 
          userId: user.id, 
          kind: "manual", 
          modules: [module], 
          dedupeKey: buildDedupeKey("manual", user.id, `${manualSlot()}-${module}`) 
        } satisfies SendIssueEvent,
      }))
    );
  } catch (err) {
    console.error("send-now: could not queue the send:", err);
    return NextResponse.json(
      { error: "Could not queue the send. Is the Inngest dev server running?" },
      { status: 503 }
    );
  }

  return NextResponse.json({ queued: true });
}
