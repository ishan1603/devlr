import { NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { composeIssue, loadComposeContext } from "@/lib/delivery/compose";
import { MODULE_ORDER } from "@/lib/delivery/schedule";

export const maxDuration = 60;

/**
 * What the reader's next issue would look like, without sending it.
 *
 * Nothing is recorded: no delivery row, no seen-history, no clock advanced. The
 * feedback links are left out because a preview is not an email.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const context = await loadComposeContext(user.id);
  if (!context) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  const active = context.subscriptions.map((s) => s.module);
  const modules = MODULE_ORDER.filter((m) => active.includes(m));

  try {
    const composed = await composeIssue(context.profile, context.subscriptions, modules, {
      withFeedback: false,
    });
    return NextResponse.json({ issue: composed?.issue ?? null });
  } catch (err) {
    console.error("preview failed:", err);
    return NextResponse.json({ error: "Could not build a preview right now." }, { status: 500 });
  }
}
