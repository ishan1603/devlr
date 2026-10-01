/**
 * Who is owed an email right now, and what goes in it.
 *
 * Recurrence is computed, never queued. A cron polls, this module answers "is
 * anything due for this user at this instant", and a missed tick heals itself
 * on the next one. The previous design had each send schedule its successor,
 * and one failure silently ended the series.
 *
 * The rule that shapes everything here: one scheduled email per user per day.
 * Modules have their own cadence, but they are all evaluated at the same
 * moment (the user's send time), and whatever is due leaves together.
 */

export type Module =
  | "digest"
  | "dev_pulse"
  | "eol_watch"
  | "repo_guard"
  | "release_radar"
  | "learn"
  | "company_radar";

export type Frequency = "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "custom";

/** Bounds on "every N days" so a typo cannot mean 0 or 40 years. */
export const MIN_CUSTOM_DAYS = 1;
export const MAX_CUSTOM_DAYS = 90;

/** Order of sections in a bundled issue: what needs action first, reading last. */
export const MODULE_ORDER: Module[] = [
  "repo_guard",
  "release_radar",
  "eol_watch",
  "digest",
  "company_radar",
  "dev_pulse",
  "learn",
];

/**
 * Modules that never trigger a send by themselves. They add a section to an
 * issue that is already going out, when they have something new to say.
 */
export const PIGGYBACK_MODULES: ReadonlySet<Module> = new Set(["eol_watch"]);

export interface ScheduleProfile {
  user_id: string;
  timezone: string | null;
  send_time: string;
  is_paused: boolean;
  onboarded_at: string | null;
}

export interface ScheduleSubscription {
  module: Module;
  is_active: boolean;
  frequency: Frequency;
  custom_interval_days?: number | null;
  last_sent_at: string | null;
}

const NOMINAL_DAYS: Record<Exclude<Frequency, "custom">, number> = {
  daily: 1,
  weekdays: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

export function frequencyDays(sub: Pick<ScheduleSubscription, "frequency" | "custom_interval_days">): number {
  if (sub.frequency === "custom") {
    return Math.min(MAX_CUSTOM_DAYS, Math.max(MIN_CUSTOM_DAYS, Math.round(sub.custom_interval_days ?? 7)));
  }
  return NOMINAL_DAYS[sub.frequency] ?? NOMINAL_DAYS.weekly;
}

/** Whole calendar days from one YYYY-MM-DD to another. */
export function daysBetween(from: string, to: string): number {
  const parse = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

export interface LocalParts {
  /** YYYY-MM-DD in the user's timezone. */
  date: string;
  /** HH:MM in the user's timezone. */
  time: string;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock date and time in the user's own timezone, not the server's. */
export function localParts(timezone: string | null, now: Date): LocalParts {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(now);

  let parts;
  try {
    parts = format(timezone || "UTC");
  } catch {
    // An unrecognised IANA zone must not take the whole cron run down.
    parts = format("UTC");
  }

  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;

  // Intl can render midnight as hour "24" in some runtimes.
  const hour = p.hour === "24" ? "00" : p.hour;

  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}`,
    weekday: WEEKDAYS[p.weekday] ?? 0,
  };
}

export interface DueResult {
  due: boolean;
  /** Local calendar date; becomes the slot in the dedupe key. */
  slot: string;
  /** Modules to include, already in section order. Empty when not due. */
  modules: Module[];
  reason: string;
}

/**
 * Cadence is counted in calendar days in the reader's own timezone, not in
 * elapsed hours.
 *
 * Hours look simpler and are wrong. A first issue sent at 3pm would make
 * tomorrow's 8am issue "only 17 hours later" and push it into the afternoon,
 * and the day after that into mid-morning, drifting for days. Counting dates
 * has no drift and no daylight-saving edge: a daily module is due when the last
 * one went out on an earlier date, whatever the time was.
 */
function moduleIsDue(sub: ScheduleSubscription, local: LocalParts, timezone: string | null): boolean {
  if (!sub.is_active) return false;
  if (sub.frequency === "weekdays" && (local.weekday === 0 || local.weekday === 6)) return false;
  if (!sub.last_sent_at) return true;

  const lastSentDate = localParts(timezone, new Date(sub.last_sent_at)).date;
  return daysBetween(lastSentDate, local.date) >= frequencyDays(sub);
}

/**
 * Is this user owed an email right now, and which modules does it carry?
 *
 * Two gates. The local wall clock must have reached their send time, and at
 * least one module that can trigger a send must have waited out its cadence.
 * Piggyback modules ride along whenever anything else is going.
 */
export function evaluateDue(
  profile: ScheduleProfile,
  subscriptions: ScheduleSubscription[],
  now: Date = new Date()
): DueResult {
  const local = localParts(profile.timezone, now);
  const slot = local.date;
  const none = (reason: string): DueResult => ({ due: false, slot, modules: [], reason });

  if (!profile.onboarded_at) return none("not onboarded");
  if (profile.is_paused) return none("paused");

  const sendTime = /^\d{2}:\d{2}$/.test(profile.send_time) ? profile.send_time : "08:00";
  if (local.time < sendTime) {
    return none(`before send time (${local.time} < ${sendTime} ${profile.timezone || "UTC"})`);
  }

  const dueSubs = subscriptions.filter((sub) => moduleIsDue(sub, local, profile.timezone));
  const triggers = dueSubs.filter((sub) => !PIGGYBACK_MODULES.has(sub.module));
  if (triggers.length === 0) return none("nothing due");

  const dueSet = new Set(dueSubs.map((s) => s.module));
  return {
    due: true,
    slot,
    modules: MODULE_ORDER.filter((m) => dueSet.has(m)),
    reason: "due",
  };
}

/**
 * How many days of content an issue should cover: the module's cadence plus a
 * day of overlap, so an article published an hour before the last send is not
 * lost between two issues. The seen-history stops it appearing twice.
 */
export function coverageDays(sub: Pick<ScheduleSubscription, "frequency" | "custom_interval_days">): number {
  return Math.min(31, frequencyDays(sub) + 1);
}
