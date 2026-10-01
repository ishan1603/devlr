"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Input, Label } from "@/components/ui";

interface ScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (scheduledTime: Date) => void;
  isScheduling?: boolean;
}

/** Local-time "YYYY-MM-DD"; toISOString would shift the date across UTC. */
function toLocalDateInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function ScheduleModal({
  isOpen,
  onClose,
  onConfirm,
  isScheduling = false,
}: ScheduleModalProps) {
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }, []);

  const [date, setDate] = useState(() => toLocalDateInput(tomorrow));
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isScheduling) onClose();
    }

    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [isOpen, onClose, isScheduling]);

  if (!isOpen) return null;

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function handleConfirm() {
    const when = new Date(`${date}T${time}`);

    // The API rejects past times with a 400. Catching it here means the user
    // gets told inline instead of via an error toast after a round trip.
    if (Number.isNaN(when.getTime())) {
      setError("That date and time could not be read.");
      return;
    }
    if (when <= new Date()) {
      setError("Pick a time in the future.");
      return;
    }

    setError(null);
    onConfirm(when);
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => !isScheduling && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-title"
        className="w-full max-w-[420px] rounded-xl border border-line bg-surface p-6 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="schedule-title" className="text-[17px] font-semibold tracking-tight">
          Schedule a one-off issue
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          A single extra briefing, on top of your normal schedule.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-date">Date</Label>
            <Input
              id="schedule-date"
              type="date"
              value={date}
              min={toLocalDateInput(new Date())}
              onChange={(e) => {
                setDate(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-time">Time</Label>
            <Input
              id="schedule-time"
              type="time"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setError(null);
              }}
            />
          </div>
        </div>

        <p className="mt-2 text-[12px] text-subtle">Times are in {timezone}.</p>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isScheduling}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} loading={isScheduling}>
            Schedule
          </Button>
        </div>
      </div>
    </div>
  );
}
