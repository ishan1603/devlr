import type { Frequency, Module } from "@/lib/delivery/schedule";

/**
 * How each module is presented. Kept apart from the modules' logic so client
 * components can import it without pulling in anything server-only.
 */

/** Modules a user can switch on today. The rest of the schema is ahead of the UI. */
export const AVAILABLE_MODULES = ["digest", "dev_pulse", "eol_watch", "repo_guard", "learn", "company_radar"] as const satisfies readonly Module[];
export type AvailableModule = (typeof AVAILABLE_MODULES)[number];

export function isAvailable(value: Module): value is AvailableModule {
  return (AVAILABLE_MODULES as readonly Module[]).includes(value);
}

export interface ModuleMeta {
  module: Module;
  name: string;
  description: string;
  /** Whether a user can switch it on today. */
  available: boolean;
  /**
   * False for modules that have no cadence of their own and ride along with
   * whatever else is being sent.
   */
  hasCadence: boolean;
  defaultFrequency: Frequency;
  defaultOn: boolean;
  /** Something about how it sends that the frequency alone does not say. */
  note?: string;
}

export const MODULE_META: ModuleMeta[] = [
  {
    module: "digest",
    name: "Dev Digest",
    description: "News, releases and deep dives for your stack, ranked for you.",
    available: true,
    hasCadence: true,
    defaultFrequency: "weekly",
    defaultOn: true,
  },
  {
    module: "dev_pulse",
    name: "Dev Pulse",
    description: "New repositories gaining stars fast in the languages you write.",
    available: true,
    hasCadence: true,
    defaultFrequency: "weekly",
    defaultOn: true,
  },
  {
    module: "eol_watch",
    name: "EOL Watch",
    description: "A warning at 90, 30 and 7 days before a version in your stack loses support.",
    available: true,
    hasCadence: false,
    defaultFrequency: "daily",
    defaultOn: true,
  },
  {
    module: "repo_guard",
    name: "Repo Guard",
    description: "Vulnerable, hijacked, deprecated or end-of-life dependencies in the repos you pick, with the fix.",
    available: true,
    hasCadence: true,
    defaultFrequency: "daily",
    // On from the start, and silent until there is a repository to watch.
    defaultOn: true,
    note: "Only sent when a scan finds something new. Anything being exploited, or critical with a fix, goes out straight away.",
  },
  {
    module: "learn",
    name: "Learn",
    description: "A system design question at your level, with a worked answer.",
    available: true,
    hasCadence: true,
    defaultFrequency: "weekdays",
    defaultOn: false,
  },
  {
    module: "company_radar",
    name: "Company Radar",
    description: "What the companies you follow shipped, wrote and open-sourced.",
    available: true,
    hasCadence: true,
    defaultFrequency: "weekly",
    defaultOn: false,
  },
  {
    module: "release_radar",
    name: "Release Radar",
    description: "Release notes for your dependencies, breaking changes first.",
    available: false,
    hasCadence: true,
    defaultFrequency: "weekly",
    defaultOn: false,
  },
];

export const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom interval" },
];

export function frequencyLabel(frequency: Frequency, customDays?: number | null): string {
  if (frequency === "custom") return `Every ${customDays ?? 3} days`;
  return FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? frequency;
}

/** Every half hour of the day, matching how often the scheduler runs. */
export const SEND_TIMES: string[] = Array.from({ length: 48 }, (_, i) => {
  const hour = String(Math.floor(i / 2)).padStart(2, "0");
  return `${hour}:${i % 2 === 0 ? "00" : "30"}`;
});

export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}
