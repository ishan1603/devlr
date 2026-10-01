"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Spinner, Wordmark, buttonClass } from "@/components/ui";

type State =
  | { status: "working" }
  | { status: "saved"; signal: number; title: string | null }
  | { status: "error"; message: string };

export default function FeedbackConfirm({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: "working" });
  // Effects run twice in development. A vote is an upsert so a repeat is
  // harmless, but there is no reason to send it twice.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;

    fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? "That did not work.");
        setState({ status: "saved", signal: body.signal, title: body.title });
      })
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  }, [token]);

  return (
    <div className="relative grid min-h-dvh place-items-center px-5 py-12">
      <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10" />
      <div className="w-full max-w-[440px] text-center">
        <Wordmark className="text-[28px]" />

        {state.status === "working" && (
          <p className="mt-10 flex items-center justify-center gap-2 text-[15px] text-muted">
            <Spinner /> Saving your feedback
          </p>
        )}

        {state.status === "saved" && (
          <div className="animate-fade-up">
            <p className="mt-10 font-mono text-[13px] text-accent">
              {state.signal > 0 ? "[+] more like this" : "[-] less like this"}
            </p>
            <h1 className="mt-3 text-[28px] font-semibold leading-tight tracking-tight">
              {state.signal > 0 ? "Noted. More of that." : "Noted. Less of that."}
            </h1>
            {state.title && <p className="mt-3 text-[15px] text-muted">&ldquo;{state.title}&rdquo;</p>}
            <p className="mt-3 text-[14px] text-subtle">Your next issue will reflect it. You can close this tab.</p>
            <Link href="/app" className={buttonClass("secondary", "md", "mt-7")}>
              Open Devlr
            </Link>
          </div>
        )}

        {state.status === "error" && (
          <div className="animate-fade-up">
            <h1 className="mt-10 text-[26px] font-semibold leading-tight tracking-tight">
              That link did not work
            </h1>
            <p className="mt-3 text-[15px] text-muted">{state.message}</p>
            <Link href="/app" className={buttonClass("secondary", "md", "mt-7")}>
              Open Devlr
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
