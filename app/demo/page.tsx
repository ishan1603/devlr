import Link from "next/link";
import { ArrowRight } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import { Eyebrow, Wordmark } from "@/components/ui";

const SCREENS = [
  { href: "/demo/onboarding", name: "Onboarding", body: "The five-step setup a new account goes through." },
  { href: "/demo/app", name: "Home", body: "The dashboard: what you get, what it is tuned to, recent issues." },
  { href: "/demo/app/topics", name: "Topics", body: "Domains, stack, level and digest length." },
  { href: "/demo/app/schedule", name: "Schedule", body: "Modules, cadence, send time and pause." },
  { href: "/demo/app/issues", name: "Issues", body: "The archive, including skipped and failed sends." },
  { href: "/demo/app/settings", name: "Settings", body: "Account, private feed and account deletion." },
  { href: "/demo/email", name: "The email", body: "The sample issue rendered exactly as it is sent." },
  { href: "/", name: "Landing page", body: "The public home page." },
];

export default function DemoIndex() {
  return (
    <div className="relative min-h-dvh">
      <div className="bg-grid mask-fade-b pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px]" />
      <header className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-5 sm:px-8">
        <Wordmark />
        <ThemeToggle />
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 pb-20 pt-8 sm:px-8 sm:pt-12">
        <Eyebrow>demo</Eyebrow>
        <h1 className="mt-3 text-[30px] font-semibold leading-tight tracking-[-0.025em] sm:text-[38px]">
          Every screen, with made-up data.
        </h1>
        <p className="mt-3 max-w-xl text-[15px] text-muted">
          No account and no database needed. Nothing you change here is saved. This area only exists
          in development.
        </p>

        <ul className="mt-9 grid gap-3 sm:grid-cols-2">
          {SCREENS.map((screen) => (
            <li key={screen.href} className="min-w-0">
              <Link
                href={screen.href}
                className="group flex h-full items-start justify-between gap-4 rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong"
              >
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold">{screen.name}</span>
                  <span className="mt-1 block text-[13px] leading-snug text-muted">{screen.body}</span>
                </span>
                <ArrowRight className="mt-0.5 size-4 shrink-0 text-subtle transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-accent" />
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
