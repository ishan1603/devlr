"use client";

import { useState } from "react";
import { Eye, EyeOff, Send } from "lucide-react";
import IssueView from "@/components/IssueView";
import { Button, Skeleton } from "@/components/ui";
import { useNotification } from "@/contexts/NotificationContext";
import { fetchPreview, sendNow } from "@/lib/api-client";
import type { Issue } from "@/lib/delivery/issue";

/**
 * "Send me one now" and "Preview".
 *
 * A preview builds the issue without sending or recording anything, so it can
 * be opened as often as someone likes. Sending queues a real issue, and
 * everything in it is then remembered as seen.
 */
export default function HomeActions({ paused }: { paused: boolean }) {
  const { showError, showSuccess, showInfo } = useNotification();
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Issue | null | undefined>(undefined);

  async function handleSend() {
    setSending(true);
    try {
      await sendNow();
      showSuccess("On its way", "It should arrive in a minute or two.");
    } catch (err) {
      showError("Could not send", err instanceof Error ? err.message : undefined);
    } finally {
      setSending(false);
    }
  }

  async function togglePreview() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setPreview(undefined);
    try {
      const result = await fetchPreview();
      setPreview(result.issue);
      if (!result.issue) showInfo("Nothing new yet", "You have already seen everything recent for your topics.");
    } catch (err) {
      setPreview(null);
      showError("Could not build a preview", err instanceof Error ? err.message : undefined);
    }
  }

  return (
    <div>
      {/* Full width and stacked on a phone, where two buttons side by side
          would each be too narrow to tap comfortably. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button onClick={handleSend} loading={sending} disabled={paused}>
          {!sending && <Send className="size-4" />}
          Send me one now
        </Button>
        <Button variant="secondary" onClick={togglePreview}>
          {open ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          {open ? "Hide preview" : "Preview next issue"}
        </Button>
      </div>

      {open && (
        <div className="mt-6 animate-fade-up">
          {preview === undefined && (
            <div className="space-y-4 rounded-2xl border border-line bg-surface p-6">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-7 w-4/5" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {preview && <IssueView issue={preview} />}
          {preview === null && (
            <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-[14px] text-muted">
              Nothing new for your topics right now. Sources are checked every two hours.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
