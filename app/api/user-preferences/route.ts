import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/server";

const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "custom"] as const;
const MIN_CUSTOM_DAYS = 1;
const MAX_CUSTOM_DAYS = 90;

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await requireUser();

  if (!user) {
    return NextResponse.json(
      { error: "You must be logged in to save preferences." },
      { status: 401 }
    );
  }

  try {
    const { categories, frequency, email, send_time, timezone, custom_interval_days } =
      await request.json();

    if (!Array.isArray(categories) || categories.length === 0) {
      return NextResponse.json(
        { error: "Categories array is required and must not be empty" },
        { status: 400 }
      );
    }

    if (!FREQUENCIES.includes(frequency)) {
      return NextResponse.json(
        { error: "Valid frequency is required (daily, weekly, biweekly)" },
        { status: 400 }
      );
    }

    const sendTime =
      typeof send_time === "string" && /^\d{2}:\d{2}$/.test(send_time) ? send_time : "09:00";

    // Only meaningful for frequency "custom"; clamped so a typo cannot schedule
    // a send every zero days, or once a decade.
    let customDays: number | null = null;
    if (frequency === "custom") {
      const n = Number(custom_interval_days);
      if (!Number.isFinite(n) || n < MIN_CUSTOM_DAYS || n > MAX_CUSTOM_DAYS) {
        return NextResponse.json(
          { error: `Interval must be between ${MIN_CUSTOM_DAYS} and ${MAX_CUSTOM_DAYS} days` },
          { status: 400 }
        );
      }
      customDays = Math.round(n);
    }

    const { error: upsertError } = await supabase.from("user_preferences").upsert(
      {
        user_id: user.id,
        categories,
        frequency,
        email: email ?? user.email,
        send_time: sendTime,
        custom_interval_days: customDays,
        timezone: typeof timezone === "string" && timezone ? timezone : "UTC",
        is_active: true,
      },
      { onConflict: "user_id" }
    );

    if (upsertError) {
      console.error("Error saving preferences:", upsertError);
      return NextResponse.json({ error: "Failed to save preferences" }, { status: 500 });
    }

    // Deliberately no inngest.send() here.
    //
    // This used to compute a send time, pass it as a `scheduledFor` data field
    // that nothing read, and omit `ts` — so the "scheduled" newsletter fired the
    // instant preferences were saved. Recurrence is now owned by the
    // newsletter/cron function, which picks this row up on its next tick.
    return NextResponse.json({
      success: true,
      message: "Preferences saved. Your newsletter is scheduled.",
    });
  } catch (error) {
    console.error("Error in user-preferences API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const { supabase, user } = await requireUser();

  if (!user) {
    return NextResponse.json(
      { error: "You must be logged in to update preferences." },
      { status: 401 }
    );
  }

  try {
    const { is_active } = await request.json();

    if (typeof is_active !== "boolean") {
      return NextResponse.json({ error: "is_active must be a boolean" }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from("user_preferences")
      .update({ is_active })
      .eq("user_id", user.id);

    if (updateError) {
      console.error("Error updating preferences:", updateError);
      return NextResponse.json({ error: "Failed to update preferences" }, { status: 500 });
    }

    // Pause and resume are now just this flag.
    //
    // The old code called a cancelUserNewsletterEvents() that only logged the
    // events it "cancelled", and a rescheduleUserNewsletter() that queued a
    // fresh chain on every resume — so repeated pause/resume compounded into
    // duplicate concurrent chains. The cron reads is_active on each tick and the
    // send function re-checks it, so nothing needs cancelling.
    return NextResponse.json({
      success: true,
      message: is_active ? "Newsletter resumed" : "Newsletter paused",
    });
  } catch (error) {
    console.error("Error in user-preferences PATCH API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  const { supabase, user } = await requireUser();

  if (!user) {
    return NextResponse.json(
      { error: "You must be logged in to fetch preferences." },
      { status: 401 }
    );
  }

  try {
    const { data: preferences, error } = await supabase
      .from("user_preferences")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Error fetching preferences:", error);
      return NextResponse.json({ error: "Failed to fetch preferences" }, { status: 500 });
    }

    if (!preferences) {
      return NextResponse.json({ error: "No preferences found" }, { status: 404 });
    }

    return NextResponse.json(preferences);
  } catch (error) {
    console.error("Error in user-preferences GET API:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
