"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/client";
import { Button, Input, Label, cx } from "@/components/ui";
import { Wordmark } from "@/components/Navbar";
import ThemeToggle from "@/components/ThemeToggle";

function SignInInner() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();
  // /auth/callback redirects here with ?error= when an emailed link is stale.
  const callbackError = useSearchParams().get("error");

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) router.replace("/dashboard");
    });
  }, [router, supabase.auth]);

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;

        // Supabase does not reveal that an address is already registered, to
        // stop attackers enumerating accounts. It returns a success with a
        // placeholder user whose identities array is empty, and sends no mail.
        // Reporting that as "check your inbox" leaves the person waiting for an
        // email that will never arrive.
        if (data.user && data.user.identities?.length === 0) {
          setIsSignUp(false);
          setError("An account with this email already exists. Sign in instead.");
          return;
        }

        // With "Confirm email" disabled, which this app requires because it has
        // no /auth/callback route to exchange a confirmation code, sign-up
        // returns a live session.
        if (data.session) {
          router.push("/select");
          return;
        }

        setMessage(
          "Check your email to confirm your account. If nothing arrives, email confirmation " +
            "is switched on in Supabase but the built-in mail service is rate limited."
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/dashboard");
      }
    } catch (err: any) {
      const raw = String(err?.message ?? "");
      if (/email not confirmed/i.test(raw)) {
        setError(
          "This account hasn't been confirmed yet. Turn off \"Confirm email\" in Supabase, " +
            "or confirm the account, then sign in."
        );
      } else if (/invalid login credentials/i.test(raw)) {
        setError("That email and password don't match an account.");
      } else {
        setError(raw || "Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="absolute right-5 top-5">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <Wordmark className="text-[32px]" />
          <p className="mt-3 text-[15px] text-muted">
            AI-written briefings on the topics you pick.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <div className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1">
            {[
              { label: "Sign in", signUp: false },
              { label: "Create account", signUp: true },
            ].map((tab) => (
              <button
                key={tab.label}
                type="button"
                onClick={() => {
                  setIsSignUp(tab.signUp);
                  setError(null);
                  setMessage(null);
                }}
                className={cx(
                  "rounded-md py-1.5 text-[13px] font-medium transition-colors",
                  isSignUp === tab.signUp
                    ? "bg-surface text-fg shadow-sm"
                    : "text-muted hover:text-fg"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
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
                  <Link
                    href="/forgot-password"
                    className="text-[13px] font-medium text-accent hover:underline"
                  >
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
              <p className="rounded-lg bg-success-soft px-3 py-2 text-[13px] text-success">
                {message}
              </p>
            )}

            <Button type="submit" size="lg" loading={isLoading} className="w-full">
              {isSignUp ? "Create account" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-[13px] text-muted">
          {isSignUp ? "Already have an account?" : "New to Sendlr?"}{" "}
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError(null);
              setMessage(null);
            }}
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
