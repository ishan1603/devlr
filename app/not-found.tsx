import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark, buttonClass } from "@/components/ui";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="relative grid min-h-dvh place-items-center px-5 py-12">
      <div className="bg-grid mask-fade pointer-events-none absolute inset-0 -z-10" />
      <div className="w-full max-w-[440px] text-center">
        <Link href="/" aria-label="Devlr home">
          <Wordmark className="text-[28px]" />
        </Link>
        <p className="mt-10 font-mono text-[13px] text-subtle">
          <span className="text-accent">$</span> devlr open --page
        </p>
        <p className="mt-1 font-mono text-[13px] text-danger">error: 404, no such page</p>
        <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-tight">Nothing lives here.</h1>
        <p className="mt-3 text-[15px] text-muted">
          The link may be old, or the issue it pointed to has aged out of the archive.
        </p>
        <Link href="/" className={buttonClass("secondary", "md", "mt-7")}>
          Back to Devlr
        </Link>
      </div>
    </div>
  );
}
