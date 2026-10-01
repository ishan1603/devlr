"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import Link from "next/link";
import { Button, Wordmark, buttonClass } from "@/components/ui";

/**
 * Catches anything thrown while rendering a page.
 *
 * The digest is shown on purpose. In production the real message is withheld
 * from the browser, so the digest is the only thing a user can quote that
 * matches a line in the server logs.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="relative grid min-h-dvh place-items-center px-5 py-12">
      <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10" />
      <div className="w-full max-w-[440px] text-center">
        <Wordmark className="text-[28px]" />
        <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-tight">Something broke on our side.</h1>
        <p className="mt-3 text-[15px] text-muted">
          Nothing you did. Trying again usually works; if it keeps happening, the reference below
          will help track it down.
        </p>
        {error.digest && (
          <p className="mt-4 font-mono text-[12px] text-subtle">ref {error.digest}</p>
        )}
        <div className="mt-7 flex justify-center gap-2">
          <Button onClick={() => retry()}>Try again</Button>
          <Link href="/" className={buttonClass("ghost")}>
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
