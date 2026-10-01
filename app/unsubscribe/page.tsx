"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui";
import { Wordmark } from "@/components/Navbar";

function UnsubscribeInner() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");

  async function confirm() {
    setState("working");
    try {
      const res = await fetch(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-[440px] text-center">
        <Wordmark className="text-[28px]" />

        {state === "done" ? (
          <>
            <h1 className="mt-8 font-serif text-[30px] leading-tight tracking-tight">
              You&rsquo;re unsubscribed
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              No more briefings will be sent. We&rsquo;ve kept your topics and schedule, so you
              can pick up where you left off if you change your mind.
            </p>
            <Link
              href="/dashboard"
              className="mt-6 inline-flex h-10 items-center rounded-lg border border-line px-4 text-[14px] font-medium transition-colors hover:bg-surface-sunken"
            >
              Back to dashboard
            </Link>
          </>
        ) : (
          <>
            <h1 className="mt-8 font-serif text-[30px] leading-tight tracking-tight">
              Stop receiving briefings?
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              We&rsquo;ll pause your newsletter right away. Nothing gets deleted, so you can
              start it up again any time from your dashboard.
            </p>

            {!token && (
              <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                This link is missing its token. Try the link in your email again.
              </p>
            )}
            {state === "error" && (
              <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                That didn&rsquo;t work. The link may have expired.
              </p>
            )}

            <div className="mt-6 flex justify-center gap-2">
              <Link
                href="/dashboard"
                className="inline-flex h-10 items-center rounded-lg px-4 text-[14px] font-medium text-muted transition-colors hover:bg-surface-sunken hover:text-fg"
              >
                Keep them
              </Link>
              <Button
                variant="danger"
                onClick={confirm}
                loading={state === "working"}
                disabled={!token}
              >
                Unsubscribe
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  // useSearchParams needs a Suspense boundary during prerendering.
  return (
    <Suspense fallback={null}>
      <UnsubscribeInner />
    </Suspense>
  );
}
