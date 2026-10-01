import { cache } from "react";
import { z } from "zod";
import { createClient } from "@/lib/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { embedText, toVectorLiteral } from "@/lib/ai/embed";
import { DOMAINS, LEVELS, STACK, interestText, sanitizeTags } from "@/lib/topics/catalog";
import { MAX_CUSTOM_DAYS, MIN_CUSTOM_DAYS, type Module } from "@/lib/delivery/schedule";
import { AVAILABLE_MODULES } from "@/lib/modules/meta";

/**
 * Reading and writing a user's own settings.
 *
 * Everything here goes through the cookie-scoped client, so row level security
 * is what enforces "your own row only". The one exception is the interest
 * embedding, which is computed server-side and written with the service role
 * because it is derived data the user never edits directly.
 */

const FREQUENCIES = ["daily", "weekdays", "weekly", "biweekly", "monthly", "custom"] as const;
type Frequency = (typeof FREQUENCIES)[number];

const domainSlugs = new Set(DOMAINS.map((d) => d.slug));
const stackSlugs = new Set(STACK.map((s) => s.slug));

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const ProfileUpdate = z
  .object({
    display_name: z.string().trim().max(80).nullable(),
    level: z.enum(LEVELS.map((l) => l.slug) as [string, ...string[]]),
    domains: z.array(z.string()).max(6),
    stack: z.array(z.string()).max(40),
    digest_length: z.enum(["short", "standard", "long"]),
    timezone: z.string().max(64).refine(isTimezone, "Unknown timezone"),
    send_time: z.string().regex(/^([01]\d|2[0-3]):(00|30)$/, "Use a time on the hour or half hour"),
    is_paused: z.boolean(),
    onboarding_step: z.string().max(32),
    /** Set true once, at the end of onboarding. */
    complete_onboarding: z.boolean(),
    subscriptions: z
      .array(
        z.object({
          module: z.enum(AVAILABLE_MODULES),
          is_active: z.boolean(),
          frequency: z.enum(FREQUENCIES),
          custom_interval_days: z.number().int().min(MIN_CUSTOM_DAYS).max(MAX_CUSTOM_DAYS).nullable().optional(),
        })
      )
      .max(AVAILABLE_MODULES.length),
  })
  .partial();

export type ProfileUpdateInput = z.infer<typeof ProfileUpdate>;

const PROFILE_COLUMNS =
  "user_id, email, display_name, level, domains, stack, digest_length, timezone, send_time, is_paused, onboarding_step, onboarded_at, feed_token, last_delivery_at, created_at";

export interface Me {
  profile: {
    user_id: string;
    email: string;
    display_name: string | null;
    level: string;
    domains: string[];
    stack: string[];
    digest_length: "short" | "standard" | "long";
    timezone: string;
    send_time: string;
    is_paused: boolean;
    onboarding_step: string;
    onboarded_at: string | null;
    feed_token: string;
    last_delivery_at: string | null;
    created_at: string;
  };
  subscriptions: {
    module: Module;
    is_active: boolean;
    frequency: Frequency;
    custom_interval_days: number | null;
    last_sent_at: string | null;
  }[];
}

/**
 * The signed-in user's settings, or null when there is no session.
 *
 * Wrapped in React's `cache` so the layout and the page it renders share one
 * lookup per request instead of each paying for their own.
 */
export const getMe = cache(async (): Promise<Me | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let { data: profile } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("user_id", user.id).maybeSingle();

  if (!profile) {
    // The signup trigger creates this row. If it is missing (an account that
    // predates the trigger), create it now rather than making every caller
    // handle the gap.
    const admin = createAdminClient();
    await admin
      .from("profiles")
      .upsert({ user_id: user.id, email: user.email ?? "" }, { onConflict: "user_id", ignoreDuplicates: true });
    ({ data: profile } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("user_id", user.id).maybeSingle());
    if (!profile) return null;
  }

  const { data: subscriptions } = await supabase
    .from("subscriptions")
    .select("module, is_active, frequency, custom_interval_days, last_sent_at")
    .eq("user_id", user.id);

  return { profile: profile as Me["profile"], subscriptions: (subscriptions ?? []) as Me["subscriptions"] };
});

/**
 * Apply a validated update. Returns an error string, or null on success.
 */
export async function updateMe(input: ProfileUpdateInput): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "Not signed in";

  const patch: Record<string, unknown> = {};
  if (input.display_name !== undefined) patch.display_name = input.display_name || null;
  if (input.level !== undefined) patch.level = input.level;
  if (input.digest_length !== undefined) patch.digest_length = input.digest_length;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.send_time !== undefined) patch.send_time = input.send_time;
  if (input.is_paused !== undefined) patch.is_paused = input.is_paused;
  if (input.onboarding_step !== undefined) patch.onboarding_step = input.onboarding_step;
  if (input.complete_onboarding) patch.onboarded_at = new Date().toISOString();

  // Unknown slugs are dropped rather than rejected, so a stale client cannot
  // wedge someone's settings page.
  const domains = input.domains ? sanitizeTags(input.domains).filter((d) => domainSlugs.has(d)) : undefined;
  const stack = input.stack ? sanitizeTags(input.stack).filter((s) => stackSlugs.has(s)) : undefined;
  if (domains) patch.domains = domains;
  if (stack) patch.stack = stack;

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("profiles").update(patch).eq("user_id", user.id);
    if (error) return error.message;
  }

  if (input.subscriptions) {
    const { error } = await supabase.from("subscriptions").upsert(
      input.subscriptions.map((s) => ({
        user_id: user.id,
        module: s.module,
        is_active: s.is_active,
        frequency: s.frequency,
        custom_interval_days: s.frequency === "custom" ? (s.custom_interval_days ?? 3) : null,
      })),
      { onConflict: "user_id,module" }
    );
    if (error) return error.message;
  }

  if (domains || stack || input.level !== undefined) {
    await refreshInterest(user.id);
  }

  return null;
}

/**
 * Recompute the vector that relevance ranking compares articles against.
 * Best effort: without an embedding key the profile simply has no vector and
 * ranking falls back to tags.
 */
export async function refreshInterest(userId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("domains, stack, level").eq("user_id", userId).maybeSingle();
  if (!data) return;

  const text = interestText((data.domains as string[]) ?? [], (data.stack as string[]) ?? [], data.level as string);
  let embedding: string | null = null;
  try {
    const vector = await embedText(text);
    embedding = vector ? toVectorLiteral(vector) : null;
  } catch (err) {
    console.warn("[profile] interest embedding failed, ranking will use tags only:", err);
  }

  await admin.from("profiles").update({ interest_text: text, interest_embedding: embedding }).eq("user_id", userId);
}
