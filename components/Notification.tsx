"use client";

import { useCallback, useEffect, useState } from "react";
import { cx } from "@/components/ui";

export interface NotificationProps {
  id: string;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message?: string;
  duration?: number;
  onClose: (id: string) => void;
}

const TONES: Record<NotificationProps["type"], { bar: string; icon: string; path: string }> = {
  success: { bar: "bg-success", icon: "text-success", path: "M5 12l4.5 4.5L19 7" },
  error: { bar: "bg-danger", icon: "text-danger", path: "M18 6L6 18M6 6l12 12" },
  warning: { bar: "bg-warning", icon: "text-warning", path: "M12 8v5m0 3.5v.5M12 3l9 16H3z" },
  info: { bar: "bg-accent", icon: "text-accent", path: "M12 8h.01M11 12h1v4h1" },
};

export default function Notification({
  id,
  type,
  title,
  message,
  duration = 5000,
  onClose,
}: NotificationProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const handleClose = useCallback(() => {
    setIsLeaving(true);
    // Matches the exit transition below, so the node is removed only once it
    // has finished animating out.
    setTimeout(() => onClose(id), 180);
  }, [id, onClose]);

  useEffect(() => {
    const enter = setTimeout(() => setIsVisible(true), 10);
    const autoClose = setTimeout(handleClose, duration);
    return () => {
      clearTimeout(enter);
      clearTimeout(autoClose);
    };
  }, [duration, handleClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const tone = TONES[type];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "pointer-events-auto flex w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-pop",
        "transition-[opacity,transform] duration-200 ease-out",
        isVisible && !isLeaving ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      )}
    >
      <span className={cx("w-1 shrink-0", tone.bar)} aria-hidden="true" />

      <div className="flex flex-1 items-start gap-3 p-3.5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cx("mt-0.5 size-4 shrink-0", tone.icon)}
          aria-hidden="true"
        >
          <path d={tone.path} />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">{title}</p>
          {message && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{message}</p>}
        </div>

        <button
          onClick={handleClose}
          aria-label="Dismiss"
          className="-m-1 shrink-0 rounded p-1 text-subtle transition-colors hover:text-fg"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
