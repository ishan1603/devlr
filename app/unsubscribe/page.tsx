"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, Wordmark, buttonClass } from "@/components/ui";

type State = "idle" | "working" | "done-all" | "done-module" | "error";

function UnsubscribeInner() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<State>("idle");

  async function confirm() {
    setState("working");
    try {
      const response = await fetch(`/api/unsubscribe?token=${encodeURIComponent(token)}`, { method: "POST" });
      if (!response.ok) return setState("error");
      const body = await response.json();
      setState(body.scope === "module" ? "done-module" : "done-all");
    } catch {
      setState("error");
    }
  }

  const done = state === "done-all" || state === "done-module";

  return (
    <div className="relative grid min-h-dvh place-items-center px-5 py-12">
      <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10" />
      <div className="w-full max-w-[440px] text-center">
        <Wordmark className="text-[28px]" />

        {done ? (
          <div className="animate-fade-up">
            <h1 className="mt-8 text-[28px] font-semibold leading-tight tracking-tight">
              {state === "done-module" ? "That one is switched off" : "You are unsubscribed"}
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              {state === "done-module"
                ? "You will not get that section again. Everything else carries on as before."
                : "No more email will be sent. Your topics and schedule are kept, so you can pick up where you left off if you change your mind."}
            </p>
            <Link href="/app/schedule" className={buttonClass("secondary", "md", "mt-6")}>
              Manage what you get
            </Link>
          </div>
        ) : (
          <>
            <h1 className="mt-8 text-[28px] font-semibold leading-tight tracking-tight">Stop this email?</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              It stops right away. Nothing is deleted, so you can switch it back on whenever you like.
            </p>

            {!token && (
              <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                This link is missing its token. Try the link in your email again.
              </p>
            )}
            {state === "error" && (
              <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                That link is not valid any more. Sign in to change what you get.
              </p>
            )}

            <div className="mt-6 flex justify-center gap-2">
              <Button onClick={confirm} loading={state === "working"} disabled={!token}>
                Unsubscribe
              </Button>
              <Link href="/app/schedule" className={buttonClass("ghost")}>
                Keep it
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={null}>
      <UnsubscribeInner />
    </Suspense>
  );
}
