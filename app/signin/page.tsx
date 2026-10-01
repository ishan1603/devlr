"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/client";
import { Button, Input, Label, Wordmark, cx } from "@/components/ui";
import ThemeToggle from "@/components/ThemeToggle";

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function SignInInner() {
  const params = useSearchParams();
  const [isSignUp, setIsSignUp] = useState(params.get("mode") === "signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();
  // /auth/callback redirects here with ?error= when an emailed link is stale.
  const callbackError = params.get("error");

  function switchMode(signUp: boolean) {
    setIsSignUp(signUp);
    setError(null);
    setMessage(null);
  }

  async function handleGithub() {
    setBusy("github");
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/app` },
    });
    // On success the browser is already navigating to GitHub.
    if (error) {
      setError(
        /provider is not enabled/i.test(error.message)
          ? "GitHub sign-in is not switched on for this project yet. Use email for now."
          : error.message
      );
      setBusy(null);
    }
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy("password");
    setError(null);
    setMessage(null);

    try {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding` },
        });
        if (error) throw error;

        // Supabase does not reveal that an address is already registered, to
        // stop attackers enumerating accounts. It returns a success with a
        // placeholder user whose identities array is empty, and sends no mail.
        // Reporting that as "check your inbox" leaves the person waiting for an
        // email that will never arrive.
        if (data.user && data.user.identities?.length === 0) {
          switchMode(false);
          setError("An account with this email already exists. Sign in instead.");
          return;
        }

        if (data.session) {
          router.push("/onboarding");
          return;
        }

        setMessage("Check your email for a link to confirm your account.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/app");
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "";
      if (/email not confirmed/i.test(raw)) {
        setError("This account has not been confirmed yet. Check your email for the link.");
      } else if (/invalid login credentials/i.test(raw)) {
        setError("That email and password don't match an account.");
      } else {
        setError(raw || "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center px-5 py-12">
      <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10" />
      <div className="absolute right-5 top-5">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[400px] animate-fade-up">
        <div className="mb-8 text-center">
          <Link href="/" aria-label="Devlr home">
            <Wordmark className="text-[30px]" />
          </Link>
          <p className="mt-3 text-[15px] text-muted">
            {isSignUp ? "Set up your developer inbox." : "Welcome back."}
          </p>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="w-full"
            loading={busy === "github"}
            disabled={busy !== null}
            onClick={handleGithub}
          >
            {busy !== "github" && <GithubMark />}
            Continue with GitHub
          </Button>

          <div className="my-5 flex items-center gap-3 font-mono text-[11px] text-subtle">
            <span className="h-px flex-1 bg-line" />
            or with email
            <span className="h-px flex-1 bg-line" />
          </div>

          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1">
            {[
              { label: "Sign in", signUp: false },
              { label: "Create account", signUp: true },
            ].map((tab) => (
              <button
                key={tab.label}
                type="button"
                onClick={() => switchMode(tab.signUp)}
                className={cx(
                  "rounded-md py-1.5 text-[13px] font-medium transition-colors",
                  isSignUp === tab.signUp ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <form onSubmit={handlePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="password">Password</Label>
                {!isSignUp && (
                  <Link href="/forgot-password" className="text-[13px] font-medium text-accent hover:underline">
                    Forgot password?
                  </Link>
                )}
              </div>
              <Input
                id="password"
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isSignUp ? "At least 6 characters" : "••••••••"}
              />
            </div>

            {(error || callbackError) && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {error ?? callbackError}
              </p>
            )}
            {message && (
              <p className="rounded-lg bg-success-soft px-3 py-2 text-[13px] text-success">{message}</p>
            )}

            <Button type="submit" size="lg" loading={busy === "password"} disabled={busy !== null} className="w-full">
              {isSignUp ? "Create account" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-[13px] text-muted">
          {isSignUp ? "Already have an account?" : "New to Devlr?"}{" "}
          <button
            type="button"
            onClick={() => switchMode(!isSignUp)}
            className="font-medium text-accent hover:underline"
          >
            {isSignUp ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
