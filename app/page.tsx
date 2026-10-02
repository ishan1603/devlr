import Link from "next/link";
import {
  ArrowRight,
  Building2,
  EyeOff,
  GraduationCap,
  Hourglass,
  Layers,
  MailCheck,
  Newspaper,
  Rocket,
  Rss,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import Hero3D from "@/components/landing/Hero3D";
import IssueView from "@/components/IssueView";
import { Badge, Eyebrow, Wordmark, buttonClass, cx } from "@/components/ui";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import { SOURCES } from "@/lib/sources/registry";

const MODULES = [
  {
    icon: Newspaper,
    name: "Dev Digest",
    live: true,
    wide: true,
    body: "News, releases and deep dives for the stack you actually use. Ranked for you, summarised once, and never the same story twice, even when five outlets cover it.",
    detail: "top story  ·  news  ·  deep dives",
  },
  {
    icon: Hourglass,
    name: "EOL Watch",
    live: true,
    body: "A heads-up at 90, 30 and 7 days before a version in your stack stops getting fixes. Dates come from the vendors.",
    detail: "Next.js 15  ·  20 days left",
  },
  {
    icon: TrendingUp,
    name: "Dev Pulse",
    live: true,
    body: "New repositories that picked up stars fast, in the languages you write.",
    detail: "weekly  ·  per language",
  },
  {
    icon: ShieldCheck,
    name: "Repo Guard",
    live: true,
    body: "Pick repos on GitHub. When a dependency is vulnerable, hijacked, deprecated or past end of life, you get one entry per package with the upgrade that clears it. Your source is never read.",
    detail: "$ npm install next@15.5.24",
  },
  {
    icon: GraduationCap,
    name: "Learn",
    live: true,
    body: "One system design question at your level, with hints. The worked answer is a click away.",
    detail: "design a rate limiter",
  },
  {
    icon: Building2,
    name: "Company Radar",
    live: true,
    body: "What the companies you follow shipped, wrote and open-sourced.",
    detail: "shipped  ·  wrote  ·  in the news",
  },
  {
    icon: Rocket,
    name: "Release Radar",
    live: true,
    body: "Release notes for your dependencies and starred repos, with breaking changes called out.",
    detail: "breaking changes first",
  },
];

const STEPS = [
  {
    title: "Say what you build",
    body: "Pick your domains and your stack. That is the whole setup, and it takes about a minute.",
    code: "devlr init --stack typescript,postgres",
  },
  {
    title: "We read everything",
    body: `${SOURCES.length} sources every two hours: official blogs, engineering write-ups, Hacker News, Lobsters. Duplicates are merged, filler is dropped.`,
    code: "devlr ingest --sources " + SOURCES.length,
  },
  {
    title: "You get one email",
    body: "On the days and at the hour you chose, in your timezone. If there is nothing worth sending, nothing is sent.",
    code: "devlr send --when 08:00",
  },
];

const PRINCIPLES = [
  {
    icon: Layers,
    title: "Never the same story twice",
    body: "Coverage of one event is grouped into one item, and what you have been shown is remembered for 90 days.",
  },
  {
    icon: EyeOff,
    title: "No tracking",
    body: "No open pixels, no click redirects, no images at all. Links go straight to the article.",
  },
  {
    icon: ShieldCheck,
    title: "Facts come from sources",
    body: "A model writes the summary. It does not decide what happened. Versions and dates are checked against the source before anything is sent.",
  },
  {
    icon: SlidersHorizontal,
    title: "It learns what you skip",
    body: "Every story has a more and a less link. Use them and the next issue shifts.",
  },
  {
    icon: Rss,
    title: "Prefer a feed?",
    body: "Every account gets a private RSS feed and an archive of past issues.",
  },
  {
    icon: MailCheck,
    title: "One click to stop",
    body: "Unsubscribe works from the email itself, without signing in. Nothing is deleted, so you can come back.",
  },
];

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export default function Home() {
  // Doubled so the strip can scroll by exactly half its width and loop
  // without a visible seam.
  const sourceNames = SOURCES.filter((s) => s.quality >= 0.8).map((s) => s.name);
  const marquee = [...sourceNames, ...sourceNames];

  return (
    <div className="relative min-h-dvh">
      <div className="bg-grid mask-fade-b pointer-events-none absolute inset-x-0 top-0 -z-10 h-[820px]" />

      <header className="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:px-8">
        <Link href="/" aria-label="Devlr home">
          <Wordmark />
        </Link>
        <nav className="ml-10 hidden items-center gap-7 text-[14px] text-muted md:flex">
          <a href="#modules" className="transition-colors hover:text-fg">
            Modules
          </a>
          <a href="#how" className="transition-colors hover:text-fg">
            How it works
          </a>
          <a href="#sample" className="transition-colors hover:text-fg">
            Sample issue
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link href="/signin" className={buttonClass("secondary", "sm", "hidden sm:inline-flex")}>
            Sign in
          </Link>
          <Link href="/signin?mode=signup" className={buttonClass("primary", "sm")}>
            Get started
          </Link>
        </div>
      </header>

      <main>
        {/* ------------------------------------------------------------ Hero */}
        {/* The 3D cards deliberately hang past the edge of their column. This
            full-width wrapper cuts them off at the screen edge, so on a phone
            they cannot make the page wider than the screen. `clip`, not
            `hidden`: it leaves the vertical axis alone. */}
        <div className="overflow-x-clip">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-6 px-5 pb-16 pt-10 sm:px-8 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:pb-24 lg:pt-20">
          <div className="min-w-0">
            <p className="animate-fade-up font-mono text-[13px] text-muted">
              <span className="text-accent">$</span> devlr init
              <span className="ml-1 inline-block h-3.5 w-[7px] translate-y-0.5 animate-blink bg-accent-fill" />
            </p>
            <h1
              className="animate-fade-up mt-5 max-w-xl text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[56px] lg:text-[64px]"
              style={{ animationDelay: "0.06s" }}
            >
              The inbox that keeps up with your <span className="text-accent">stack</span>.
            </h1>
            <p
              className="animate-fade-up mt-6 max-w-lg text-[17px] leading-relaxed text-muted sm:text-[18px]"
              style={{ animationDelay: "0.12s" }}
            >
              Devlr reads {SOURCES.length} developer sources, keeps what matters for what you build, and
              sends it as one email on your schedule. News, end-of-life warnings, and the repos worth
              knowing about.
            </p>
            <div className="animate-fade-up mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "0.18s" }}>
              <Link href="/signin?mode=signup" className={buttonClass("primary", "lg", "group")}>
                Start reading
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <a href="#sample" className={buttonClass("secondary", "lg")}>
                See a real issue
              </a>
            </div>
            <p
              className="animate-fade-up mt-5 font-mono text-[12px] text-subtle"
              style={{ animationDelay: "0.24s" }}
            >
              free  ·  no card  ·  no tracking pixels  ·  one-click unsubscribe
            </p>
          </div>

          <Hero3D />
        </section>
        </div>

        {/* --------------------------------------------------------- Sources */}
        <section aria-label="Sources" className="border-y border-line py-5">
          <div className="mask-fade-x overflow-hidden">
            <div className="flex w-max animate-marquee gap-10 pr-10 font-mono text-[13px] text-subtle">
              {marquee.map((name, i) => (
                <span key={i} className="whitespace-nowrap">
                  {name}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- Modules */}
        <section id="modules" className="mx-auto w-full max-w-6xl scroll-mt-10 px-5 py-20 sm:px-8 sm:py-28">
          <div className="reveal max-w-2xl">
            <Eyebrow>modules</Eyebrow>
            <h2 className="mt-3 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">
              Switch on what you want. It all arrives as one email.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-muted">
              Each module has its own rhythm. Whatever is due on a given day is bundled together, so
              you never get more than one scheduled email a day.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((mod) => (
              <article
                key={mod.name}
                className={cx(
                  // min-w-0: a grid item refuses to shrink below its content by
                  // default, and the nowrap line at the bottom would otherwise
                  // push the whole grid wider than a phone screen.
                  "reveal group relative flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-6",
                  "transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-line-strong",
                  mod.wide && "sm:col-span-2 lg:col-span-1 lg:row-span-1"
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-xl bg-surface-sunken text-accent transition-colors group-hover:bg-accent-soft">
                    <mod.icon className="size-5" />
                  </span>
                  <Badge tone={mod.live ? "accent" : "neutral"}>{mod.live ? "Live" : "Soon"}</Badge>
                </div>
                <h3 className="mt-5 text-[18px] font-semibold tracking-tight">{mod.name}</h3>
                <p className="mt-2 flex-1 text-[14px] leading-relaxed text-muted">{mod.body}</p>
                <p className="mt-5 truncate border-t border-line pt-4 font-mono text-[12px] text-subtle">
                  {mod.detail}
                </p>
              </article>
            ))}

            <article className="reveal flex min-w-0 flex-col justify-between rounded-2xl border border-dashed border-line-strong p-6 sm:col-span-2 lg:col-span-2">
              <div>
                <Eyebrow>one inbox</Eyebrow>
                <h3 className="mt-3 text-[20px] font-semibold tracking-tight">
                  Security first, reading last.
                </h3>
                <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">
                  Sections are ordered by how soon you need to act: alerts, then lifecycles, then news,
                  then things to learn from. An issue with nothing new is skipped, not padded.
                </p>
              </div>
              <p className="mt-6 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-subtle">
                repo guard → release radar → eol watch → digest → company radar → dev pulse → learn
              </p>
            </article>
          </div>
        </section>

        {/* ---------------------------------------------------- How it works */}
        <section id="how" className="scroll-mt-10 border-y border-line bg-surface">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="reveal max-w-2xl">
              <Eyebrow>how it works</Eyebrow>
              <h2 className="mt-3 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">
                A minute to set up. Then it just shows up.
              </h2>
            </div>

            <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="reveal flex min-w-0 flex-col bg-surface p-6 sm:p-7">
                  <span className="font-mono text-[13px] text-accent">0{i + 1}</span>
                  <h3 className="mt-4 text-[18px] font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-2 flex-1 text-[14px] leading-relaxed text-muted">{step.body}</p>
                  <p className="mt-6 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[12px] text-muted">
                    <span className="text-accent">$</span> {step.code}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------------------------------------------------- Sample issue */}
        <section id="sample" className="mx-auto w-full max-w-6xl scroll-mt-10 px-5 py-20 sm:px-8 sm:py-28">
          <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <div className="reveal min-w-0 lg:sticky lg:top-24 lg:self-start">
              <Eyebrow>a real issue</Eyebrow>
              <h2 className="mt-3 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">
                This is what lands in your inbox.
              </h2>
              <p className="mt-4 text-[16px] leading-relaxed text-muted">
                Not a mock-up. This is the output of a real run on October 1 for someone who works
                with TypeScript, React and Postgres.
              </p>
              <ul className="mt-8 space-y-4 text-[14px] text-muted">
                {[
                  ["Readable in plain text", "Every issue ships a real text version for terminal mail clients."],
                  ["Written to be skimmed", "A headline, where it came from, and two sentences on why it matters."],
                  ["Light and dark", "The email follows your mail client's theme where the client allows it."],
                ].map(([title, body]) => (
                  <li key={title} className="flex gap-3">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-fill" />
                    <span>
                      <span className="font-medium text-fg">{title}.</span> {body}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <IssueView issue={SAMPLE_ISSUE} className="reveal min-w-0" />
          </div>
        </section>

        {/* ------------------------------------------------------ Principles */}
        <section className="border-t border-line">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="reveal max-w-2xl">
              <Eyebrow>principles</Eyebrow>
              <h2 className="mt-3 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">
                Built the way you would build it.
              </h2>
            </div>

            <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {PRINCIPLES.map((item) => (
                <div key={item.title} className="reveal">
                  <item.icon className="size-5 text-accent" />
                  <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- CTA */}
        <section className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8 sm:pb-28">
          <div className="reveal relative overflow-hidden rounded-3xl border border-line bg-surface px-6 py-14 text-center sm:px-12 sm:py-20">
            <div className="bg-grid mask-fade pointer-events-none absolute inset-0" />
            <div className="relative">
              <h2 className="mx-auto max-w-2xl text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[46px]">
                Read less. Miss nothing that matters.
              </h2>
              <p className="mx-auto mt-4 max-w-md text-[16px] text-muted">
                Tell Devlr what you build and get your first issue today.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link href="/signin?mode=signup" className={buttonClass("primary", "lg", "group")}>
                  Get started
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <a
                  href="https://github.com/ishan1603/devlr"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass("secondary", "lg")}
                >
                  <GithubMark className="size-4" />
                  Source on GitHub
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-[13px] text-subtle sm:px-8">
          <span className="flex items-center gap-3">
            <Wordmark className="text-[16px] text-fg" />
            <span>The developer inbox.</span>
          </span>
          <span className="flex items-center gap-5">
            <a href="#modules" className="hover:text-fg">
              Modules
            </a>
            <a href="https://github.com/ishan1603/devlr" target="_blank" rel="noopener noreferrer" className="hover:text-fg">
              GitHub
            </a>
            <Link href="/signin" className="hover:text-fg">
              Sign in
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
