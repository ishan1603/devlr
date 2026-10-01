import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { inngest } from "@/lib/inngest/client";
import { buildDedupeKey, immediateSlot } from "@/lib/newsletter/dedupe";

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "You must be logged in to send a newsletter." },
      { status: 401 }
    );
  }

  try {
    const { data: preferences, error } = await supabase
      .from("user_preferences")
      .select("categories, is_active")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !preferences) {
      return NextResponse.json(
        { error: "User preferences not found. Please set up your newsletter first." },
        { status: 404 }
      );
    }

    if (!preferences.is_active) {
      return NextResponse.json(
        { error: "Newsletter is currently paused. Please resume it first." },
        { status: 400 }
      );
    }

    // Minute-resolution slot: an impatient double-click resolves to the same key
    // and the second event is suppressed rather than sending a second email.
    const dedupeKey = buildDedupeKey("immediate", user.id, immediateSlot());

    const { ids } = await inngest.send({
      name: "newsletter.schedule",
      data: { userId: user.id, kind: "immediate", dedupeKey },
    });

    return NextResponse.json({
      success: true,
      message: "Newsletter is being generated and sent",
      eventId: ids[0],
    });
  } catch (error) {
    console.error("Error in send-newsletter API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
