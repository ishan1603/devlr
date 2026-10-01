"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useNotification } from "@/contexts/NotificationContext";
import ConfirmModal from "@/components/ConfirmModal";
import ScheduleModal from "@/components/ScheduleModal";
import { Badge, Button, Card, CardHeader, EmptyState, Page, Skeleton } from "@/components/ui";

interface UserPreferences {
  categories: string[];
  frequency: string;
  email: string;
  is_active: boolean;
  created_at: string;
  send_time?: string;
  timezone?: string;
  last_sent_at?: string | null;
}

interface SendRecord {
  id: string;
  send_kind: "immediate" | "scheduled" | "recurring";
  status: "sending" | "sent" | "failed" | "skipped";
  article_count: number | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  categories: string[];
}

const STATUS: Record<
  SendRecord["status"],
  { tone: "success" | "danger" | "neutral" | "warning"; label: string }
> = {
  sent: { tone: "success", label: "Delivered" },
  failed: { tone: "danger", label: "Failed" },
  // A skip is not an error: there was simply nothing the reader had not seen.
  skipped: { tone: "neutral", label: "Nothing new" },
  sending: { tone: "warning", label: "Sending" },
};

function formatTime12h(time: string) {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

/** Fixed locale and UTC keep server and client markup identical. */
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function DashboardPage() {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [sends, setSends] = useState<SendRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<"pause" | "resume" | "send-now" | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const router = useRouter();
  const { user } = useAuth();
  const { showSuccess, showError } = useNotification();

  const loadSends = useCallback(async () => {
    try {
      const res = await fetch("/api/sends");
      if (res.ok) setSends((await res.json()).sends ?? []);
    } catch {
      // History is supplementary; failing to load it must not blank the page.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/user-preferences");
        if (res.ok) {
          if (!cancelled) setPreferences(await res.json());
        } else if (res.status === 404) {
          // No preferences yet means a new account, not an error. The old code
          // sent these users to /subscribe, a route that does not exist.
          router.replace("/select");
          return;
        }
      } catch {
        if (!cancelled) showError("Couldn't load", "Failed to load your settings.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
      await loadSends();
    })();

    return () => {
      cancelled = true;
    };
  }, [router, loadSends, showError]);

  async function handleScheduleConfirm(scheduledTime: Date) {
    setIsScheduling(true);
    try {
      const res = await fetch("/api/schedule-newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledTime: scheduledTime.toISOString() }),
      });

      if (res.ok) {
        showSuccess(
          "Scheduled",
          `Your next issue is queued for ${formatDate(scheduledTime.toISOString())}.`
        );
        await loadSends();
      } else {
        showError("Couldn't schedule", (await res.json()).error ?? "Please try again.");
      }
    } catch {
      showError("Couldn't schedule", "Please try again.");
    } finally {
      setIsScheduling(false);
      setShowScheduleModal(false);
    }
  }

  async function handleConfirmAction() {
    if (!user || !pendingAction) return;

    if (pendingAction === "send-now") {
      setIsSending(true);
      try {
        const res = await fetch("/api/send-newsletter", { method: "POST" });
        if (res.ok) {
          showSuccess("On its way", "Your newsletter is being written and sent.");
          // The run is async, so its row appears a moment later.
          setTimeout(loadSends, 2500);
        } else {
          showError("Couldn't send", (await res.json()).error ?? "Please try again.");
        }
      } catch {
        showError("Couldn't send", "Please try again.");
      } finally {
        setIsSending(false);
        setShowConfirmModal(false);
        setPendingAction(null);
      }
      return;
    }

    const activating = pendingAction === "resume";
    try {
      const res = await fetch("/api/user-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: activating }),
      });

      if (res.ok) {
        setPreferences((prev) => (prev ? { ...prev, is_active: activating } : null));
        showSuccess(
          activating ? "Resumed" : "Paused",
          activating
            ? "You'll receive issues on schedule again."
            : "No issues will be sent until you resume."
        );
      } else {
        showError("Couldn't update", "Please try again.");
      }
    } catch {
      showError("Couldn't update", "Please try again.");
    } finally {
      setShowConfirmModal(false);
      setPendingAction(null);
    }
  }

  if (isLoading) {
    return (
      <Page className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }

  const active = preferences?.is_active ?? false;

  const stats = [
    { label: "Frequency", value: preferences?.frequency ?? "Not set" },
    {
      label: "Delivery time",
      value: preferences?.send_time ? formatTime12h(preferences.send_time) : "Not set",
    },
    { label: "Timezone", value: preferences?.timezone ?? "UTC" },
    {
      label: "Last sent",
      value: preferences?.last_sent_at ? formatDate(preferences.last_sent_at) : "Never",
    },
  ];

  return (
    <Page className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[34px] leading-tight tracking-tight">Your briefing</h1>
          <p className="mt-1 text-[15px] text-muted">
            Delivered to <span className="text-fg">{preferences?.email ?? user?.email}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShowScheduleModal(true)} disabled={!active}>
            Schedule one
          </Button>
          <Button
            onClick={() => {
              setPendingAction("send-now");
              setShowConfirmModal(true);
            }}
            disabled={!active}
          >
            Send now
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Schedule"
          description={active ? "Running normally." : "Paused, so nothing will be sent."}
          action={
            <Badge tone={active ? "success" : "neutral"}>
              <span className={active ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-subtle"} />
              {active ? "Active" : "Paused"}
            </Badge>
          }
        />
        <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-surface px-5 py-4">
              <dt className="text-[12px] uppercase tracking-wide text-subtle">{stat.label}</dt>
              <dd className="mt-1 text-[15px] font-medium capitalize">{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
          <div className="flex flex-wrap gap-1.5">
            {(preferences?.categories ?? []).map((c) => (
              <Badge key={c} tone="accent" className="capitalize">
                {c}
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => router.push("/select")}>
              Edit topics
            </Button>
            <Button
              variant={active ? "danger" : "secondary"}
              size="sm"
              onClick={() => {
                setPendingAction(active ? "pause" : "resume");
                setShowConfirmModal(true);
              }}
            >
              {active ? "Pause" : "Resume"}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent issues" description="Your last 20 sends." />
        {sends.length === 0 ? (
          <EmptyState
            title="No issues yet"
            description="Once your first briefing goes out, it'll show up here with what was included."
          />
        ) : (
          <ul className="divide-y divide-line">
            {sends.map((s) => {
              const meta = STATUS[s.status];
              const detail =
                s.status === "skipped"
                  ? "Nothing new since the last issue"
                  : s.error
                    ? s.error
                    : `${s.article_count ?? 0} ${s.article_count === 1 ? "story" : "stories"}`;

              return (
                <li key={s.id} className="flex items-center gap-4 px-5 py-3.5">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px]">{detail}</p>
                    <p className="mt-0.5 text-[12px] capitalize text-subtle">
                      {s.send_kind} · {formatDate(s.sent_at ?? s.created_at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => {
          setShowConfirmModal(false);
          setPendingAction(null);
        }}
        onConfirm={handleConfirmAction}
        isLoading={isSending}
        tone={pendingAction === "pause" ? "danger" : "default"}
        title={
          pendingAction === "send-now"
            ? "Send an issue now?"
            : pendingAction === "pause"
              ? "Pause your newsletter?"
              : "Resume your newsletter?"
        }
        message={
          pendingAction === "send-now"
            ? "We'll pull the latest stories in your topics and email you a briefing. Stories you've already received won't be repeated."
            : pendingAction === "pause"
              ? "Nothing will be sent until you resume. Your topics and schedule are kept."
              : "You'll start receiving issues on your schedule again."
        }
        confirmLabel={
          pendingAction === "send-now" ? "Send now" : pendingAction === "pause" ? "Pause" : "Resume"
        }
      />

      <ScheduleModal
        isOpen={showScheduleModal}
        onClose={() => setShowScheduleModal(false)}
        onConfirm={handleScheduleConfirm}
        isScheduling={isScheduling}
      />
    </Page>
  );
}
