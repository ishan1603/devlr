import type { Issue, Section, StoryItem } from "@/lib/delivery/issue";
import { cx } from "@/components/ui";

/**
 * An issue, rendered for the web.
 *
 * Mirrors the email (lib/email/IssueEmail.tsx) section for section, but with
 * theme tokens instead of inline colours, since a web page can use CSS
 * variables and an email cannot. No hooks, so it renders on the server or the
 * client: the landing page, onboarding and the dashboard all use it.
 */

function formatStars(stars: number): string {
  return stars >= 1000 ? `${(stars / 1000).toFixed(stars >= 10_000 ? 0 : 1)}k` : String(stars);
}

function eolPhrase(daysLeft: number): string {
  if (daysLeft < 0) return `ended ${-daysLeft} ${-daysLeft === 1 ? "day" : "days"} ago`;
  if (daysLeft === 0) return "ends today";
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="border-t border-line pt-4 font-mono text-[12px]">
      <span className="text-subtle">{"// "}</span>
      <span className="font-semibold text-accent">{label}</span>
    </p>
  );
}

function Story({ item, lead }: { item: StoryItem; lead: boolean }) {
  const meta = [item.site, ...item.meta].filter(Boolean);
  return (
    <article className="mt-4">
      <h3
        className={cx(
          "font-semibold tracking-tight",
          lead ? "text-[20px] leading-[1.3] sm:text-[22px]" : "text-[16px] leading-snug sm:text-[17px]"
        )}
      >
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
          {item.title}
        </a>
      </h3>
      {meta.length > 0 && (
        <p className="mt-1 break-words font-mono text-[12px] text-subtle">{meta.join("  ·  ")}</p>
      )}
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{item.summary}</p>
      {item.alsoCoveredBy.length > 0 && (
        <p className="mt-1.5 text-[13px] text-subtle">
          Also covered by{" "}
          {item.alsoCoveredBy.map((other, i) => (
            <span key={other.url}>
              {i > 0 && ", "}
              <a href={other.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-fg">
                {other.name}
              </a>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

function renderSection(section: Section, index: number) {
  const key = `${section.module}-${section.label}`;

  if (section.type === "stories") {
    return (
      <section key={key} className="mt-7">
        <SectionLabel label={section.label} />
        {section.items.map((item, i) => (
          <Story key={item.ref} item={item} lead={index === 0 && i === 0} />
        ))}
      </section>
    );
  }

  if (section.type === "repos") {
    return (
      <section key={key} className="mt-7">
        <SectionLabel label={section.label} />
        {section.repos.map((repo) => (
          <article key={repo.fullName} className="mt-4">
            <h3 className="break-all font-mono text-[14px] font-semibold">
              <a href={repo.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
                {repo.fullName}
              </a>
            </h3>
            <p className="mt-0.5 font-mono text-[12px] text-subtle">
              {[`${formatStars(repo.stars)} stars`, repo.language].filter(Boolean).join("  ·  ")}
            </p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{repo.blurb || repo.description}</p>
          </article>
        ))}
      </section>
    );
  }

  return (
    <section key={key} className="mt-7">
      <SectionLabel label={section.label} />
      <ul className="mt-2 divide-y divide-line">
        {section.entries.map((entry) => (
          <li key={entry.ref} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold">
                {entry.product} {entry.cycle}
              </p>
              <p className="mt-0.5 font-mono text-[12px] text-subtle">
                end of life {entry.eolDate}
                {entry.latest ? `  ·  current is ${entry.latest}` : ""}
              </p>
            </div>
            <span
              className={cx(
                "shrink-0 font-mono text-[12px] font-semibold",
                entry.daysLeft <= 7 ? "text-danger" : entry.daysLeft <= 30 ? "text-warning" : "text-muted"
              )}
            >
              {eolPhrase(entry.daysLeft)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function IssueView({ issue, className }: { issue: Issue; className?: string }) {
  return (
    <div className={cx("overflow-hidden rounded-2xl border border-line bg-surface shadow-card", className)}>
      {/* The masthead is dark in both themes, as it is in the email. */}
      <div className="bg-fg px-5 py-4 dark:bg-surface-sunken sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[20px] font-bold tracking-tight text-bg dark:text-fg">
            Devlr<span className="text-accent-fill">.</span>
          </span>
          <span className="font-mono text-[12px] text-subtle">{formatDate(issue.date)}</span>
        </div>
        <p className="mt-2 truncate font-mono text-[12px] text-subtle">
          <span className="text-accent-fill">$</span> devlr read --issue {issue.date.slice(0, 10)}
        </p>
      </div>

      <div className="px-5 pb-7 pt-6 sm:px-8">
        {issue.intro && <p className="text-[16px] leading-relaxed sm:text-[17px]">{issue.intro}</p>}
        {issue.sections.map(renderSection)}
      </div>
    </div>
  );
}
