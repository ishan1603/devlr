"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/client";
import { Button, Input, Label } from "@/components/ui";
import { Wordmark } from "@/components/ui";
import ThemeToggle from "@/components/ThemeToggle";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const base = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        // Supabase appends the code to this URL. It has to point at the
        // callback route, which trades the code for a session; only then can
        // the reset form call updateUser.
        redirectTo: `${base}/auth/callback?next=/reset-password`,
      });
      if (error) throw error;

      // Shown whether or not the address exists. Confirming which emails are
      // registered would hand an attacker a list of your users.
      setSent(true);
    } catch (err: any) {
      setError(err?.message ?? "Could not send the reset email. Please try again.");
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
        </div>

        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          {sent ? (
            <>
              <h1 className="text-[19px] font-semibold tracking-tight">Check your email</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">
                If an account exists for <span className="text-fg">{email}</span>, we&rsquo;ve sent
                a link to reset your password. It expires in an hour.
              </p>
              <p className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-[13px] leading-relaxed text-muted">
                Nothing arriving? Supabase&rsquo;s built-in mail service is rate limited to a few
                messages per hour. Configuring custom SMTP makes these reliable.
              </p>
              <Link
                href="/signin"
                className="mt-5 inline-flex h-10 items-center rounded-lg border border-line px-4 text-[14px] font-medium transition-colors hover:bg-surface-sunken"
              >
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-[19px] font-semibold tracking-tight">Reset your password</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">
                Enter your email and we&rsquo;ll send you a link to set a new one.
              </p>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
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

                {error && (
                  <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {error}
                  </p>
                )}

                <Button type="submit" size="lg" loading={isLoading} className="w-full">
                  Send reset link
                </Button>
              </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[13px] text-muted">
          Remembered it?{" "}
          <Link href="/signin" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
