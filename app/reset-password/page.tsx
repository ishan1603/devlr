"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/client";
import { Button, Input, Label } from "@/components/ui";
import { Wordmark } from "@/components/ui";
import ThemeToggle from "@/components/ThemeToggle";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  // Arriving here means /auth/callback already traded the emailed code for a
  // session. Without one, updateUser has no user to act on, so say that plainly
  // rather than showing a form that cannot work.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setHasSession(!!session);
      setChecking(false);
    });
  }, [supabase.auth]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    if (password.length < 6) {
      setError("Use at least 6 characters.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      router.push("/app");
    } catch (err: any) {
      setError(err?.message ?? "Could not update your password. Please try again.");
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
          {checking ? (
            <p className="text-[14px] text-muted">Checking your link&hellip;</p>
          ) : !hasSession ? (
            <>
              <h1 className="text-[19px] font-semibold tracking-tight">This link has expired</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">
                Password reset links are single use and expire after an hour. Request a fresh one
                and open it in this browser.
              </p>
              <Link
                href="/forgot-password"
                className="mt-5 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                Request a new link
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-[19px] font-semibold tracking-tight">Choose a new password</h1>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">
                You&rsquo;ll be signed in once it&rsquo;s saved.
              </p>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Type it again"
                  />
                </div>

                {error && (
                  <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {error}
                  </p>
                )}

                <Button type="submit" size="lg" loading={isLoading} className="w-full">
                  Save password
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
