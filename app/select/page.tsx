"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useNotification } from "@/contexts/NotificationContext";
import TimePicker from "@/components/TimePicker";
import { Button, Card, CardHeader, Input, Label, Page, Skeleton, cx } from "@/components/ui";

const CATEGORIES = [
  { id: "technology", name: "Technology", description: "Software, hardware, AI and startups" },
  { id: "business", name: "Business", description: "Markets, earnings and the economy" },
  { id: "sports", name: "Sports", description: "Results, transfers and tournaments" },
  { id: "entertainment", name: "Entertainment", description: "Film, TV, music and streaming" },
  { id: "science", name: "Science", description: "Research, discoveries and space" },
  { id: "health", name: "Health", description: "Medicine, treatments and wellbeing" },
  { id: "politics", name: "Politics", description: "Policy, elections and government" },
  { id: "environment", name: "Environment", description: "Climate, energy and conservation" },
];

const FREQUENCIES = [
  { id: "daily", name: "Daily", description: "Every morning" },
  { id: "weekly", name: "Weekly", description: "Once every 7 days" },
  // The backend treats biweekly as a ~14-day interval. This option used to be
  // labelled "Twice a week", which promised the opposite of what it delivers.
  { id: "biweekly", name: "Every two weeks", description: "Once every 14 days" },
  { id: "monthly", name: "Monthly", description: "Once every 30 days" },
  { id: "custom", name: "Custom", description: "Choose your own interval" },
];

export default function SelectPage() {
  const [selected, setSelected] = useState<string[]>([]);
  const [frequency, setFrequency] = useState("weekly");
  const [sendTime, setSendTime] = useState("09:00");
  const [customDays, setCustomDays] = useState(3);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();
  const { user } = useAuth();
  const { showSuccess, showError, showWarning } = useNotification();

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetch("/api/user-preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setSelected(data.categories ?? []);
        setFrequency(data.frequency ?? "weekly");
        setSendTime(data.send_time ?? "09:00");
        if (data.custom_interval_days) setCustomDays(data.custom_interval_days);
      })
      .catch(() => {
        // A missing row just means this is a first visit.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handleSave() {
    if (selected.length === 0) {
      showWarning("Pick a topic", "Choose at least one topic to build your briefing from.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categories: selected,
          frequency,
          send_time: sendTime,
          custom_interval_days: frequency === "custom" ? customDays : undefined,
          email: user?.email,
          // send_time is a wall-clock time, so it is meaningless without the
          // zone it was chosen in; the server stores UTC otherwise.
          timezone,
        }),
      });

      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save");

      showSuccess("Saved", "Your next issue will follow this schedule.");
      router.push("/dashboard");
    } catch (err: any) {
      showError("Couldn't save", err?.message ?? "Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <Page className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  }

  return (
    <Page className="space-y-6">
      <div>
        <h1 className="font-serif text-[34px] leading-tight tracking-tight">
          What should we read for you?
        </h1>
        <p className="mt-1 text-[15px] text-muted">
          Pick your topics and when you want them. You can change this any time.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Topics"
          description="We'll only include stories you haven't already been sent."
          action={
            <span className="shrink-0 text-[13px] tabular-nums text-muted">
              {selected.length} selected
            </span>
          }
        />
        <div className="grid gap-2 p-4 sm:grid-cols-2">
          {CATEGORIES.map((c) => {
            const on = selected.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                aria-pressed={on}
                className={cx(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  on
                    ? "border-accent bg-accent-soft"
                    : "border-line hover:border-line-strong hover:bg-surface-sunken"
                )}
              >
                <span
                  className={cx(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded border",
                    on ? "border-accent bg-accent text-on-accent" : "border-line-strong"
                  )}
                >
                  {on && (
                    <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M2.5 6.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium">{c.name}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{c.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="Delivery" description={`Times are in ${timezone}.`} />
        <div className="space-y-5 p-5">
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">How often</legend>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {FREQUENCIES.map((f) => {
                const on = frequency === f.id;
                return (
                  <label
                    key={f.id}
                    className={cx(
                      "cursor-pointer rounded-lg border p-3 transition-colors",
                      on
                        ? "border-accent bg-accent-soft"
                        : "border-line hover:border-line-strong hover:bg-surface-sunken"
                    )}
                  >
                    <input
                      type="radio"
                      name="frequency"
                      value={f.id}
                      checked={on}
                      onChange={() => setFrequency(f.id)}
                      className="sr-only"
                    />
                    <span className="block text-[14px] font-medium">{f.name}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">{f.description}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {frequency === "custom" && (
            <div className="max-w-[280px] space-y-1.5">
              <Label htmlFor="custom-days">Send every</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="custom-days"
                  type="number"
                  min={1}
                  max={90}
                  value={customDays}
                  onChange={(e) => setCustomDays(Number(e.target.value))}
                  className="w-24"
                />
                <span className="text-[14px] text-muted">
                  {customDays === 1 ? "day" : "days"}
                </span>
              </div>
              <p className="text-[12px] text-subtle">Between 1 and 90 days.</p>
            </div>
          )}

          <div className="max-w-[220px] space-y-1.5">
            <Label htmlFor="send-time">Delivery time</Label>
            <TimePicker id="send-time" value={sendTime} onChange={setSendTime} />
          </div>
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => router.push("/dashboard")}>
          Cancel
        </Button>
        <Button size="lg" onClick={handleSave} loading={isSaving} disabled={selected.length === 0}>
          Save preferences
        </Button>
      </div>
    </Page>
  );
}
