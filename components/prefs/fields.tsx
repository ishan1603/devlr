"use client";

import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { Badge, Chip, Input, Label, Select, Switch, cx } from "@/components/ui";
import { DOMAINS, LEVELS, STACK, type StackKind } from "@/lib/topics/catalog";
import {
  FREQUENCY_OPTIONS,
  MODULE_META,
  SEND_TIMES,
  formatTime,
  isAvailable,
  type AvailableModule,
  type ModuleMeta,
} from "@/lib/modules/meta";
import { MAX_CUSTOM_DAYS, MIN_CUSTOM_DAYS, type Frequency, type Module } from "@/lib/delivery/schedule";

/**
 * The preference controls, shared by onboarding and the settings pages so the
 * two can never drift apart. Each is a controlled component: it owns no data,
 * only presentation.
 */

function toggle(list: string[], value: string, max?: number): string[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  if (max && list.length >= max) return list;
  return [...list, value];
}

/* --------------------------------------------------------------- Domains -- */

export const MAX_DOMAINS = 4;

export function DomainPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const atLimit = value.length >= MAX_DOMAINS;

  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {DOMAINS.map((domain) => {
        const selected = value.includes(domain.slug);
        const disabled = !selected && atLimit;
        return (
          <button
            key={domain.slug}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(toggle(value, domain.slug, MAX_DOMAINS))}
            className={cx(
              "flex items-start gap-3 rounded-xl border p-4 text-left",
              "transition-[background-color,border-color,transform,opacity] duration-150 active:scale-[0.99]",
              selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
              disabled && "cursor-not-allowed opacity-45"
            )}
          >
            <span
              className={cx(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border transition-colors",
                selected ? "border-accent bg-accent-fill text-on-accent" : "border-line-strong"
              )}
            >
              {selected && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold">{domain.name}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-muted">{domain.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- Stack -- */

const KIND_LABELS: Record<StackKind, string> = {
  language: "Languages",
  framework: "Frameworks",
  runtime: "Runtimes",
  database: "Databases and data",
  cloud: "Cloud",
  tool: "Tools and infrastructure",
  ai: "AI",
};

const KIND_ORDER: StackKind[] = ["language", "framework", "runtime", "database", "cloud", "tool", "ai"];

export function StackPicker({
  value,
  onChange,
  domains,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** When given, items from these domains are listed first within each group. */
  domains?: string[];
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const relevant = new Set(domains ?? []);
    return KIND_ORDER.map((kind) => {
      const items = STACK.filter(
        (item) =>
          item.kind === kind &&
          (!needle || item.name.toLowerCase().includes(needle) || item.slug.includes(needle))
      ).sort((a, b) => {
        const ra = a.domains.some((d) => relevant.has(d)) ? 0 : 1;
        const rb = b.domains.some((d) => relevant.has(d)) ? 0 : 1;
        return ra - rb;
      });
      return { kind, items };
    }).filter((group) => group.items.length > 0);
  }, [query, domains]);

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search languages, frameworks, tools"
          aria-label="Search your stack"
          className="pl-9"
        />
      </div>

      <div className="mt-5 space-y-5">
        {groups.map((group) => (
          <div key={group.kind}>
            <p className="mb-2.5 font-mono text-[12px] text-subtle">{KIND_LABELS[group.kind]}</p>
            <div className="flex flex-wrap gap-2">
              {group.items.map((item) => (
                <Chip
                  key={item.slug}
                  selected={value.includes(item.slug)}
                  onClick={() => onChange(toggle(value, item.slug))}
                >
                  {item.name}
                </Chip>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="py-6 text-center text-[13px] text-muted">
            Nothing matches &ldquo;{query}&rdquo;. Pick the closest domain instead and it will still be covered.
          </p>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Level -- */

export function LevelPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Experience level">
      {LEVELS.map((level) => (
        <Chip
          key={level.slug}
          role="radio"
          aria-checked={value === level.slug}
          selected={value === level.slug}
          onClick={() => onChange(level.slug)}
        >
          {level.name}
        </Chip>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- Digest length -- */

const LENGTHS = [
  { value: "short", label: "Short", detail: "5 stories" },
  { value: "standard", label: "Standard", detail: "8 stories" },
  { value: "long", label: "Long", detail: "12 stories" },
] as const;

export function LengthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: "short" | "standard" | "long") => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Digest length">
      {LENGTHS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              "rounded-xl border px-3 py-3 text-left transition-colors",
              selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"
            )}
          >
            <span className="block text-[14px] font-semibold">{option.label}</span>
            <span className="block font-mono text-[12px] text-muted">{option.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- Modules -- */

export interface ModuleSetting {
  module: AvailableModule;
  is_active: boolean;
  frequency: Frequency;
  custom_interval_days: number | null;
}

interface StoredSetting {
  module: Module;
  is_active?: boolean;
  frequency?: Frequency;
  custom_interval_days?: number | null;
}

/** Fill in defaults for modules the user has no row for yet. */
export function withModuleDefaults(existing: StoredSetting[]): ModuleSetting[] {
  const settings: ModuleSetting[] = [];
  for (const meta of MODULE_META) {
    if (!isAvailable(meta.module)) continue;
    const found = existing.find((e) => e.module === meta.module);
    settings.push({
      module: meta.module,
      is_active: found?.is_active ?? meta.defaultOn,
      frequency: found?.frequency ?? meta.defaultFrequency,
      custom_interval_days: found?.custom_interval_days ?? null,
    });
  }
  return settings;
}

function ModuleRow({
  meta,
  setting,
  onChange,
}: {
  meta: ModuleMeta;
  setting?: ModuleSetting;
  onChange: (next: ModuleSetting) => void;
}) {
  if (!meta.available || !setting) {
    return (
      <div className="flex items-start justify-between gap-4 px-5 py-4 opacity-60">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">{meta.name}</p>
          <p className="mt-0.5 text-[13px] text-muted">{meta.description}</p>
        </div>
        <Badge>Soon</Badge>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">{meta.name}</p>
          <p className="mt-0.5 text-[13px] text-muted">{meta.description}</p>
        </div>
        <Switch
          checked={setting.is_active}
          onChange={(is_active) => onChange({ ...setting, is_active })}
          label={`${meta.name} ${setting.is_active ? "on" : "off"}`}
        />
      </div>

      {setting.is_active && (
        <div className="mt-3">
          {meta.hasCadence ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={setting.frequency}
                onChange={(e) => onChange({ ...setting, frequency: e.target.value as Frequency })}
                aria-label={`${meta.name} frequency`}
                className="w-full sm:w-52"
              >
                {FREQUENCY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              {setting.frequency === "custom" && (
                <label className="flex items-center gap-2 text-[13px] text-muted">
                  every
                  <Input
                    type="number"
                    min={MIN_CUSTOM_DAYS}
                    max={MAX_CUSTOM_DAYS}
                    value={setting.custom_interval_days ?? 3}
                    onChange={(e) =>
                      onChange({
                        ...setting,
                        custom_interval_days: Math.min(
                          MAX_CUSTOM_DAYS,
                          Math.max(MIN_CUSTOM_DAYS, Number(e.target.value) || MIN_CUSTOM_DAYS)
                        ),
                      })
                    }
                    aria-label="Interval in days"
                    className="h-9 w-20 text-[13px]"
                  />
                  days
                </label>
              )}
            </div>
          ) : (
            <p className="font-mono text-[12px] text-subtle">
              No schedule of its own. It is added to an issue when there is something to report.
            </p>
          )}
          {meta.note && <p className="mt-2 text-[13px] text-muted">{meta.note}</p>}
        </div>
      )}
    </div>
  );
}

export function ModuleList({
  value,
  onChange,
  showUpcoming = true,
}: {
  value: ModuleSetting[];
  onChange: (next: ModuleSetting[]) => void;
  showUpcoming?: boolean;
}) {
  const metas = MODULE_META.filter((m) => m.available || showUpcoming);
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {metas.map((meta) => (
        <ModuleRow
          key={meta.module}
          meta={meta}
          setting={value.find((v) => v.module === meta.module)}
          onChange={(next) => onChange(value.map((v) => (v.module === next.module ? next : v)))}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- Schedule -- */

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

export function ScheduleFields({
  sendTime,
  timezone,
  onChange,
}: {
  sendTime: string;
  timezone: string;
  onChange: (next: { sendTime: string; timezone: string }) => void;
}) {
  const zones = useMemo(() => {
    const all = timezones();
    return all.includes(timezone) ? all : [timezone, ...all];
  }, [timezone]);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="send-time">Send at</Label>
        <Select id="send-time" value={sendTime} onChange={(e) => onChange({ sendTime: e.target.value, timezone })}>
          {SEND_TIMES.map((time) => (
            <option key={time} value={time}>
              {formatTime(time)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="timezone">Timezone</Label>
        <Select id="timezone" value={timezone} onChange={(e) => onChange({ sendTime, timezone: e.target.value })}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
