import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import { Wordmark } from "@/components/Navbar";
import HeroNewspaper from "@/components/HeroNewspaper";

const STEPS = [
  {
    title: "Pick your topics",
    body: "Eight verticals, from technology to environment. Choose as many as you like.",
  },
  {
    title: "Set a rhythm",
    body: "Daily, weekly or monthly, at an hour you pick, in your own timezone.",
  },
  {
    title: "Read the briefing",
    body: "We read the week's reporting and write you a short, linked summary. You never get the same story twice.",
  },
];

export default function Home() {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center px-5 sm:px-8">
        <Wordmark />
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link
            href="/signin"
            className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-5 sm:px-8">
        <section className="grid items-center gap-12 border-b border-line py-16 sm:py-24 lg:grid-cols-[1.1fr_0.9fr] lg:gap-8">
          <div>
            <p className="text-[13px] font-medium uppercase tracking-widest text-accent">
              AI-written briefings
            </p>
            <h1 className="mt-4 max-w-2xl font-serif text-[44px] leading-[1.08] tracking-tight sm:text-[58px]">
              The news you care about, written down and sent to you.
            </h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">
              Sendlr reads across your chosen topics and writes a short briefing on your schedule.
              No feed, no endless scrolling. Just an email that respects your time.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/signin"
                className="inline-flex h-11 items-center rounded-lg bg-accent px-6 text-[15px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                Start reading
              </Link>
              <span className="text-[13px] text-subtle">Free. No card required.</span>
            </div>
          </div>

          <HeroNewspaper />
        </section>

        <section className="grid gap-px border-b border-line bg-line sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.title} className="bg-bg px-1 py-10 sm:px-6">
              <span className="font-mono text-[13px] text-accent">0{i + 1}</span>
              <h2 className="mt-3 text-[17px] font-semibold tracking-tight">{step.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{step.body}</p>
            </div>
          ))}
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-4 py-10 text-[13px] text-subtle">
          <span>Sendlr. Built with Next.js, Supabase, Inngest and Groq.</span>
          <Link href="/signin" className="hover:text-fg">
            Sign in
          </Link>
        </footer>
      </main>
    </div>
  );
}
