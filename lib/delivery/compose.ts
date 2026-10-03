import { createAdminClient } from "@/lib/supabase-admin";
import { editIssue, interestNames, templateCopy, type EditorOutput } from "@/lib/delivery/editor";
import { MODULE_ORDER, coverageDays, type Frequency, type Module } from "@/lib/delivery/schedule";
import { guardSection, type Issue, type ModuleResult, type Section } from "@/lib/delivery/issue";
import { assembleDigest } from "@/lib/modules/digest";
import { assembleEol } from "@/lib/modules/eol";
import { guardCopy } from "@/lib/guard/news";
import { assembleGuard } from "@/lib/modules/guard";
import { assemblePulse } from "@/lib/modules/pulse";
import { assembleLearn } from "@/lib/modules/learn";
import { assembleCompanyRadar, assembleReleaseRadar } from "@/lib/modules/radar";

/**
 * Composition: several modules, one email.
 *
 * Each module is asked independently what it has for this reader. Whatever
 * comes back is laid out in a fixed order (things that need action first,
 * reading last) and handed to the editor for a subject and an intro.
 *
 * A module that has nothing to say contributes nothing, and is reported as
 * such so its schedule is not advanced: it stays due and is asked again
 * tomorrow.
 */

export interface ComposeProfile {
  user_id: string;
  email: string;
  display_name: string | null;
  domains: string[];
  stack: string[];
  digest_length: "short" | "standard" | "long";
  interest_embedding: unknown;
  unsubscribe_token: string;
  feed_token: string;
}

export interface ComposeSubscription {
  module: Module;
  frequency: Frequency;
  custom_interval_days: number | null;
}

export interface Composed {
  issue: Issue;
  seen: ModuleResult["seen"];
  /** Modules that produced at least one section. */
  contributing: Module[];
  /** Repo Guard findings to mark as told once the email has gone. */
  guardFindingIds: number[];
}

const PREHEADER_MAX = 110;

export async function loadComposeContext(userId: string): Promise<{
  profile: ComposeProfile;
  subscriptions: ComposeSubscription[];
} | null> {
  const supabase = createAdminClient();
  const [{ data: profile }, { data: subscriptions }] = await Promise.all([
    supabase
      .from("profiles")
      .select(
        "user_id, email, display_name, domains, stack, digest_length, interest_embedding, unsubscribe_token, feed_token"
      )
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("subscriptions")
      .select("module, frequency, custom_interval_days")
      .eq("user_id", userId)
      .eq("is_active", true),
  ]);

  if (!profile) return null;
  return {
    profile: profile as ComposeProfile,
    subscriptions: (subscriptions ?? []) as ComposeSubscription[],
  };
}

async function runModule(
  name: Module,
  profile: ComposeProfile,
  subscription: ComposeSubscription | undefined,
  options: { withFeedback: boolean }
): Promise<ModuleResult> {
  switch (name) {
    case "digest":
      return assembleDigest(profile, {
        windowDays: coverageDays(subscription ?? { frequency: "weekly" }),
        withFeedback: options.withFeedback,
      });
    case "dev_pulse":
      return assemblePulse(profile);
    case "eol_watch":
      return assembleEol(profile);
    case "repo_guard":
      return assembleGuard(profile);
    case "learn":
      return assembleLearn(profile);
    case "company_radar":
      return assembleCompanyRadar(profile);
    case "release_radar":
      return assembleReleaseRadar(profile);
    default:
      return { sections: [], seen: [] };
  }
}

async function previousIntros(userId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("deliveries")
    .select("payload")
    .eq("user_id", userId)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(3);

  return (data ?? [])
    .map((row) => (row.payload as { intro?: string } | null)?.intro)
    .filter((intro): intro is string => Boolean(intro));
}

/**
 * Build one issue for one reader from the given modules.
 *
 * Returns null when no module had anything, which the caller records as a
 * skip rather than a failure.
 */
export async function composeIssue(
  profile: ComposeProfile,
  subscriptions: ComposeSubscription[],
  modules: Module[],
  options: { withFeedback?: boolean; now?: Date } = {}
): Promise<Composed | null> {
  const now = options.now ?? new Date();
  const wanted = MODULE_ORDER.filter((m) => modules.includes(m));

  const sections: Section[] = [];
  const seen: ModuleResult["seen"] = [];
  const contributing: Module[] = [];
  const guardFindingIds: number[] = [];

  for (const name of wanted) {
    // One module failing must not cost the reader the rest of the issue.
    try {
      const result = await runModule(
        name,
        profile,
        subscriptions.find((s) => s.module === name),
        { withFeedback: options.withFeedback !== false }
      );
      if (result.sections.length === 0) continue;
      sections.push(...result.sections);
      seen.push(...result.seen);
      guardFindingIds.push(...(result.notified ?? []));
      contributing.push(name);
    } catch (err) {
      console.error(`[compose] module ${name} failed for ${profile.user_id}:`, err);
    }
  }

  if (sections.length === 0) return null;

  // A security finding leads the issue, and its subject line is not left to a
  // model. The editor still writes the opening, about the reading that
  // follows, which is the part it is good at and cannot get dangerously wrong.
  const guard = guardSection(sections);
  const reading = sections.filter((s) => s.type !== "guard");

  let copy: EditorOutput;
  if (guard && reading.length === 0) {
    copy = { ...guardCopy(guard, false), aiEdited: false };
  } else {
    const firstReading = reading[0];
    if (firstReading && (firstReading.module === "digest" || firstReading.module === "dev_pulse")) {
      const edited = await editIssue({
        sections: reading,
        interests: interestNames(profile.domains, profile.stack),
        previousIntros: await previousIntros(profile.user_id),
        date: now,
      });
      if (guard) {
        const fixed = guardCopy(guard, false);
        const step = fixed.preheader.split(" Plus ")[0];
        copy = {
          subject: fixed.subject,
          preheader: `${step} Also: ${edited.subject}`.slice(0, PREHEADER_MAX),
          intro: edited.intro,
          aiEdited: edited.aiEdited,
        };
      } else {
        copy = edited;
      }
    } else {
      copy = templateCopy({
        sections: reading,
        interests: interestNames(profile.domains, profile.stack),
        previousIntros: await previousIntros(profile.user_id),
        date: now,
      });
      // guard will override the subject/preheader but intro remains what templateCopy produced
      if (guard) {
        const fixed = guardCopy(guard, false);
        const step = fixed.preheader.split(" Plus ")[0];
        copy.subject = fixed.subject;
        copy.preheader = `${step} Also: ${copy.subject}`.slice(0, PREHEADER_MAX);
      }
    }
  }

  return {
    issue: {
      subject: copy.subject,
      preheader: copy.preheader,
      intro: copy.intro,
      date: now.toISOString(),
      sections,
      aiEdited: copy.aiEdited,
    },
    seen,
    contributing,
    guardFindingIds,
  };
}
