export type Frequency = "daily" | "weekly" | "biweekly" | "monthly" | "custom";

/** Bounds on "every N days" so a typo cannot mean 0 or 40 years. */
export const MIN_CUSTOM_DAYS = 1;
export const MAX_CUSTOM_DAYS = 90;

export interface Preference {
  user_id: string;
  email: string;
  categories: string[];
  frequency: Frequency;
  send_time: string;
  timezone: string | null;
  is_active: boolean;
  last_sent_at: string | null;
  custom_interval_days?: number | null;
}

/**
 * Minimum gap before a user is eligible again. Deliberately shorter than the
 * nominal period (20h rather than 24h) so a cron tick that lands a few minutes
 * early, or a DST shift that shortens the local day, doesn't skip a slot
 * entirely. The per-day dedupe key is what actually prevents a double send.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const NOMINAL_DAYS: Record<Exclude<Frequency, "custom">, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

/** Shave the nominal period by ~15% to absorb cron jitter and DST. */
function requiredGapMs(pref: Preference): number {
  if (pref.frequency === "custom") {
    const days = Math.min(
      MAX_CUSTOM_DAYS,
      Math.max(MIN_CUSTOM_DAYS, Math.round(pref.custom_interval_days ?? 7))
    );
    return days * DAY_MS * 0.85;
  }
  const days = NOMINAL_DAYS[pref.frequency] ?? NOMINAL_DAYS.weekly;
  return days * DAY_MS * 0.85;
}

/** Wall-clock date and time in the user's own timezone, not the server's. */
export function localParts(timezone: string, now: Date): { date: string; time: string } {
  let tz = timezone || "UTC";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
  } catch {
    // An unrecognised IANA zone must not take the whole cron run down.
    tz = "UTC";
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
  }

  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;

  // Intl can render midnight as hour "24" in some runtimes.
  const hour = p.hour === "24" ? "00" : p.hour;

  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}

export interface DueResult {
  due: boolean;
  /** Local calendar date of the slot; becomes the dedupe key's slot component. */
  slot: string;
  reason: string;
}

/**
 * Is this user owed a newsletter right now?
 *
 * Two independent gates: the local wall clock must have reached their send_time,
 * and enough time must have elapsed since the last successful send. The slot is
 * the local date, so re-running the cron within the same day is a no-op at the
 * database's unique index even if last_sent_at never got written.
 */
export function isDue(pref: Preference, now: Date = new Date()): DueResult {
  const { date, time } = localParts(pref.timezone || "UTC", now);
  const slot = date;

  if (!pref.is_active) return { due: false, slot, reason: "paused" };
  if (!pref.categories?.length) return { due: false, slot, reason: "no categories" };

  const sendTime = /^\d{2}:\d{2}$/.test(pref.send_time) ? pref.send_time : "09:00";
  if (time < sendTime) {
    return { due: false, slot, reason: `before send_time (${time} < ${sendTime} ${pref.timezone || "UTC"})` };
  }

  if (pref.last_sent_at) {
    const elapsed = now.getTime() - new Date(pref.last_sent_at).getTime();
    if (elapsed < requiredGapMs(pref)) {
      const hours = Math.round(elapsed / 3_600_000);
      return { due: false, slot, reason: `only ${hours}h since last send (${pref.frequency})` };
    }
  }

  return { due: true, slot, reason: "due" };
}
