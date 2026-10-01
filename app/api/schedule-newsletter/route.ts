import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { inngest } from "@/lib/inngest/client";
import { buildDedupeKey } from "@/lib/newsletter/dedupe";

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "You must be logged in to schedule a newsletter." },
      { status: 401 }
    );
  }

  try {
    const { scheduledTime } = await request.json();

    if (!scheduledTime) {
      return NextResponse.json({ error: "Scheduled time is required." }, { status: 400 });
    }

    const scheduleDate = new Date(scheduledTime);
    if (Number.isNaN(scheduleDate.getTime())) {
      return NextResponse.json({ error: "Scheduled time is not a valid date." }, { status: 400 });
    }
    if (scheduleDate <= new Date()) {
      return NextResponse.json({ error: "Scheduled time must be in the future." }, { status: 400 });
    }

    const { data: preferences, error } = await supabase
      .from("user_preferences")
      .select("is_active")
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

    const slot = scheduleDate.toISOString();
    const dedupeKey = buildDedupeKey("scheduled", user.id, slot);

    // A future `ts` is what actually delays the run; Inngest treats it as a
    // sleepUntil at the head of the function.
    const { ids } = await inngest.send({
      name: "newsletter.schedule",
      data: { userId: user.id, kind: "scheduled", slot, dedupeKey },
      ts: scheduleDate.getTime(),
    });

    return NextResponse.json({
      success: true,
      message: "Newsletter scheduled successfully",
      eventId: ids[0],
      scheduledFor: slot,
    });
  } catch (error) {
    console.error("Error in schedule-newsletter API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
