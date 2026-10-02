"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Send } from "lucide-react";
import { GithubOutcome } from "@/components/app/repo-actions";
import IssueView from "@/components/IssueView";
import RepoStep from "@/components/onboarding/RepoStep";
import {
  DomainPicker,
  LengthPicker,
  LevelPicker,
  MAX_DOMAINS,
  ModuleList,
  ScheduleFields,
  StackPicker,
  withModuleDefaults,
  type ModuleSetting,
} from "@/components/prefs/fields";
import { Button, Skeleton, Wordmark, cx } from "@/components/ui";
import { useNotification } from "@/contexts/NotificationContext";
import { fetchPreview, saveMe, sendNow } from "@/lib/api-client";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import type { Issue } from "@/lib/delivery/issue";
import type { Me } from "@/lib/profile";

const STEPS = [
  { id: "domains", title: "What do you build?", hint: `Pick up to ${MAX_DOMAINS}. This decides what counts as news for you.` },
  { id: "stack", title: "What's in your stack?", hint: "The more specific, the better the ranking. You can change this any time." },
  { id: "repos", title: "Got code on GitHub?", hint: "Devlr reads its dependency manifests, never the source, and tells you when something in them needs fixing." },
  { id: "modules", title: "What do you want in your inbox?", hint: "Everything due on the same day arrives as one email." },
  { id: "schedule", title: "When should it arrive?", hint: "Your local time. Each module keeps the rhythm you just picked." },
  { id: "preview", title: "Here is your first issue", hint: "Built from what was published recently, for the choices you just made." },
] as const;

/**
 * The preview step. A component of its own so its state starts empty every
 * time the step is entered, with no reset to perform.
 */
function FirstIssuePreview() {
  // undefined: still loading. null: nothing to show yet.
  const [preview, setPreview] = useState<Issue | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchPreview()
      .then((result) => !cancelled && setPreview(result.issue))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, []);

  if (preview === undefined) {
    return (
      <div className="space-y-4 rounded-2xl border border-line bg-surface p-6">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (preview) return <IssueView issue={preview} />;

  return (
    <div>
      <p className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-[14px] text-muted">
        There is nothing fresh enough for your exact choices yet. Sources are checked every two
        hours, so your first real issue will be built from the next pass. This is what one looks
        like:
      </p>
      <IssueView issue={SAMPLE_ISSUE} />
    </div>
  );
}

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function OnboardingFlow({
  initial,
  doneHref = "/app",
  githubOutcome,
  githubConnectHref = "/api/github/connect",
}: {
  initial: Me;
  /** Where to go once setup is finished. */
  doneHref?: string;
  /** The `github` query parameter, when the reader has just come back from GitHub. */
  githubOutcome?: string;
  /** Where "Connect GitHub" goes. Null in the demo. */
  githubConnectHref?: string | null;
}) {
  const router = useRouter();
  const { showError, showSuccess } = useNotification();
  const reduceMotion = useReducedMotion();

  const startAt = Math.max(0, STEPS.findIndex((s) => s.id === initial.profile.onboarding_step));
  const [step, setStep] = useState(startAt);
  const [direction, setDirection] = useState(1);
  const [saving, setSaving] = useState(false);

  const [domains, setDomains] = useState(initial.profile.domains);
  const [level, setLevel] = useState(initial.profile.level);
  const [stack, setStack] = useState(initial.profile.stack);
  const [length, setLength] = useState(initial.profile.digest_length);
  const [modules, setModules] = useState<ModuleSetting[]>(withModuleDefaults(initial.subscriptions));
  const [sendTime, setSendTime] = useState(initial.profile.send_time);
  // A fresh profile is created in UTC. The browser knows better.
  const [timezone, setTimezone] = useState(
    initial.profile.timezone === "UTC" ? detectTimezone() : initial.profile.timezone
  );

  const [sending, setSending] = useState(false);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  function canContinue(): boolean {
    if (current.id === "domains") return domains.length > 0;
    if (current.id === "modules") return modules.some((mod) => mod.is_active);
    return true;
  }

  /** Persist the current step, then move. Progress survives a closed tab. */
  async function go(delta: 1 | -1) {
    const next = step + delta;
    if (delta === -1) {
      setDirection(-1);
      setStep(next);
      return;
    }

    setSaving(true);
    try {
      await saveMe({
        domains,
        level,
        stack,
        digest_length: length,
        subscriptions: modules,
        send_time: sendTime,
        timezone,
        onboarding_step: STEPS[next].id,
      });
      setDirection(1);
      setStep(next);
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    } catch (err) {
      showError("Could not save", err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  async function finish(sendFirst: boolean) {
    const setBusy = sendFirst ? setSending : setSaving;
    setBusy(true);
    try {
      await saveMe({ complete_onboarding: true, onboarding_step: "done" });
      if (sendFirst) {
        await sendNow();
        showSuccess("On its way", "Your first issue should arrive in a minute or two.");
      }
      router.push(doneHref);
      router.refresh();
    } catch (err) {
      showError("Could not finish setup", err instanceof Error ? err.message : undefined);
      setBusy(false);
    }
  }

  const offset = reduceMotion ? 0 : 28;

  return (
    <LazyMotion features={domAnimation}>
      <GithubOutcome outcome={githubOutcome} />
      <div className="relative min-h-dvh">
        <div className="bg-grid mask-fade-b pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px]" />

        <header className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-5 sm:px-8">
          <Wordmark />
          <span className="font-mono text-[12px] text-subtle">
            step {step + 1} of {STEPS.length}
          </span>
        </header>

        <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
          <div
            className="flex gap-1.5"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={STEPS.length}
            aria-valuenow={step + 1}
            aria-label="Setup progress"
          >
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={cx(
                  "h-1 flex-1 rounded-full transition-colors duration-500",
                  i <= step ? "bg-accent-fill" : "bg-surface-sunken"
                )}
              />
            ))}
          </div>
        </div>

        <main className="mx-auto w-full max-w-3xl px-5 pb-36 pt-10 sm:px-8 sm:pt-14">
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <m.div
              key={current.id}
              custom={direction}
              initial={{ opacity: 0, x: direction * offset }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -direction * offset }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.025em] sm:text-[36px]">
                {current.title}
              </h1>
              <p className="mt-2 text-[15px] text-muted sm:text-[16px]">{current.hint}</p>

              <div className="mt-8">
                {current.id === "domains" && (
                  <div className="space-y-8">
                    <DomainPicker value={domains} onChange={setDomains} />
                    <div>
                      <p className="mb-3 text-[14px] font-medium">Where are you in your career?</p>
                      <LevelPicker value={level} onChange={setLevel} />
                    </div>
                  </div>
                )}

                {current.id === "stack" && <StackPicker value={stack} onChange={setStack} domains={domains} />}

                {current.id === "repos" && <RepoStep connectHref={githubConnectHref} />}

                {current.id === "modules" && (
                  <div className="space-y-8">
                    <ModuleList value={modules} onChange={setModules} />
                    <div>
                      <p className="mb-3 text-[14px] font-medium">How long should the digest be?</p>
                      <LengthPicker value={length} onChange={setLength} />
                    </div>
                  </div>
                )}

                {current.id === "schedule" && (
                  <div className="rounded-xl border border-line bg-surface p-5">
                    <ScheduleFields
                      sendTime={sendTime}
                      timezone={timezone}
                      onChange={(next) => {
                        setSendTime(next.sendTime);
                        setTimezone(next.timezone);
                      }}
                    />
                    <p className="mt-4 font-mono text-[12px] text-subtle">
                      At most one scheduled email a day. Nothing new means nothing sent.
                    </p>
                  </div>
                )}

                {current.id === "preview" && <FirstIssuePreview />}
              </div>
            </m.div>
          </AnimatePresence>
        </main>

        {/* Pinned so the way forward is always on screen, however long the
            step is. The bottom padding clears the iOS home indicator. */}
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/85 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-8">
            {step > 0 && (
              <Button variant="ghost" onClick={() => go(-1)} disabled={saving || sending}>
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Back</span>
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {isLast ? (
                <>
                  <Button variant="secondary" onClick={() => finish(false)} loading={saving} disabled={sending}>
                    {!saving && <Check className="size-4" />}
                    Finish
                  </Button>
                  <Button onClick={() => finish(true)} loading={sending} disabled={saving}>
                    {!sending && <Send className="size-4" />}
                    Send it to me now
                  </Button>
                </>
              ) : (
                <Button onClick={() => go(1)} loading={saving} disabled={!canContinue()}>
                  Continue
                  {!saving && <ArrowRight className="size-4" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </LazyMotion>
  );
}
