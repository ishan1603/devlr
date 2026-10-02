import Link from "next/link";
import { ArrowLeft, ArrowUpRight, GitBranch, Lock, ShieldCheck } from "lucide-react";
import {
  AddRepoForm,
  CopyButton,
  DisconnectButton,
  GithubOutcome,
  RemoveRepoButton,
  ScanButton,
  ScanPoller,
  WatchSwitch,
} from "@/components/app/repo-actions";
import { Badge, Card, CardHeader, EmptyState, Eyebrow, Page, Spinner, buttonClass, cx } from "@/components/ui";
import type { PackageReport } from "@/lib/guard/rollup";
import type { Finding } from "@/lib/guard/types";
import {
  badgeMarkdown,
  badgeUrl,
  countsLabel,
  runtimeName,
  sourceLabel,
  timeAgo,
  type GuardAccount,
  type RepoDetail,
  type RepoSummary,
} from "@/lib/guard/view";

/**
 * The Repos screens, as plain functions of their data.
 *
 * Pages fetch and pass the result in, the same way the rest of the app does,
 * so /demo renders these with made-up data and no database.
 */

const gradeTone = (grade: string | null) =>
  grade === "A" || grade === "B"
    ? "border-accent/40 bg-accent-soft text-accent"
    : grade === "C"
      ? "border-warning/40 bg-warning-soft text-warning"
      : "border-danger/40 bg-danger-soft text-danger";

/** The grade as a mark. A repo with no grade yet shows why instead. */
export function GradeMark({ repo, large }: { repo: RepoSummary; large?: boolean }) {
  const box = cx(
    "grid shrink-0 place-items-center rounded-lg border font-mono font-bold",
    large ? "size-14 text-[26px]" : "size-10 text-[17px]"
  );

  if (!repo.watching) {
    return <span className={cx(box, "border-line bg-surface-sunken text-subtle")} aria-hidden="true">-</span>;
  }
  if (repo.scan_status === "pending") {
    return (
      <span className={cx(box, "border-line bg-surface-sunken text-subtle")} role="status" aria-label="Scanning">
        <Spinner />
      </span>
    );
  }
  if (repo.health_grade === null) {
    return (
      <span className={cx(box, "border-danger/40 bg-danger-soft text-danger")} aria-label="Scan failed">
        !
      </span>
    );
  }
  return (
    <span className={cx(box, gradeTone(repo.health_grade))} aria-label={`Grade ${repo.health_grade}`}>
      {repo.health_grade}
    </span>
  );
}

export function statusLine(repo: RepoSummary, now: Date): string {
  if (!repo.watching) return "Not watched";
  if (repo.scan_status === "pending") return "Scanning now";
  if (repo.scan_status === "failed") return repo.scan_error ?? "The last scan failed.";

  const parts = [countsLabel(repo.counts) || "Nothing to fix"];
  if (repo.stats.dependencies !== undefined) parts.push(`${repo.stats.dependencies} dependencies`);
  if (repo.scanned_at) parts.push(`scanned ${timeAgo(repo.scanned_at, now)}`);
  return parts.join("  ·  ");
}

function RepoBadges({ repo }: { repo: RepoSummary }) {
  return (
    <>
      {repo.is_private && (
        <Badge>
          <Lock className="size-3" />
          private
        </Badge>
      )}
      {repo.is_archived && <Badge>archived</Badge>}
    </>
  );
}

/* ------------------------------------------------------------------ List -- */

export function ReposView({
  repos,
  account,
  basePath = "/app",
  outcome,
  connectHref = "/api/github/connect",
  now = new Date(),
}: {
  repos: RepoSummary[];
  account: GuardAccount;
  basePath?: string;
  /** The `github` query parameter after coming back from GitHub. */
  outcome?: string;
  /** Where "Connect GitHub" goes. Null in the demo, where there is nothing to connect to. */
  connectHref?: string | null;
  now?: Date;
}) {
  const connect = (query: string) => (connectHref ? `${connectHref}?${query}` : "#");
  const watched = repos.filter((r) => r.watching);
  const others = repos.filter((r) => !r.watching);
  const atLimit = watched.length >= account.limit;
  const scanning = watched.some((r) => r.scan_status === "pending");

  return (
    <Page>
      <GithubOutcome outcome={outcome} />
      <ScanPoller active={scanning} />

      <Eyebrow>repo guard</Eyebrow>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.025em] sm:text-[34px]">Repos</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-muted">
        Devlr reads the dependency manifests of the repositories you pick and tells you when something in them is
        vulnerable, hijacked, deprecated or past end of life, with the command that fixes it. It never reads your
        source code.
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="GitHub" description="For private repositories, and to scan again when you push." />
          <div className="p-5">
            {account.accounts.length > 0 ? (
              <ul className="space-y-3">
                {account.accounts.map((github) => (
                  <li key={github.installationId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium">
                      <GitBranch className="size-4 shrink-0 text-subtle" />
                      <span className="truncate">{github.login}</span>
                      {github.suspended && <Badge tone="warning">suspended</Badge>}
                    </span>
                    <DisconnectButton installationId={github.installationId} login={github.login} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-relaxed text-muted">
                {account.githubConfigured
                  ? "Read-only, and only for the repositories you choose on GitHub's own screen. Devlr asks for contents and metadata, nothing else, and stores no token."
                  : "This deployment has no GitHub App yet, so private repositories are not available. Public ones can be watched by name."}
              </p>
            )}

            {account.githubConfigured && (
              <div className="mt-4 flex flex-wrap gap-2">
                {account.accounts.length === 0 ? (
                  <a href={connect(`from=${basePath}/repos`)} className={buttonClass("primary", "md")}>
                    <GitBranch className="size-4" />
                    Connect GitHub
                  </a>
                ) : (
                  <a href={connect(`mode=install&from=${basePath}/repos`)} className={buttonClass("secondary", "sm")}>
                    Choose repositories on GitHub
                  </a>
                )}
              </div>
            )}
          </div>
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Watch a public repository" description="Yours, or an open-source project you depend on." />
          <div className="p-5">
            <AddRepoForm disabled={atLimit} />
            <p className="mt-3 font-mono text-[12px] text-subtle">
              watching {watched.length} of {account.limit}
            </p>
          </div>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Watched" description="Scanned when you push, and again every day against new advisories." />
        {watched.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="size-6" />}
            title="No repositories yet"
            description="Connect GitHub or add a public repository above. The first scan takes a few seconds."
          />
        ) : (
          <ul className="divide-y divide-line">
            {watched.map((repo) => (
              <li key={repo.id} className="flex items-center gap-3 px-5 py-4 sm:gap-4">
                <Link href={`${basePath}/repos/${repo.id}`} className="group flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                  <GradeMark repo={repo} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="[overflow-wrap:anywhere] font-mono text-[14px] font-semibold group-hover:text-accent">
                        {repo.full_name}
                      </span>
                      <RepoBadges repo={repo} />
                    </span>
                    <span
                      className={cx(
                        "mt-1 block text-[13px]",
                        repo.scan_status === "failed" ? "text-danger" : "text-muted"
                      )}
                    >
                      {statusLine(repo, now)}
                    </span>
                  </span>
                </Link>
                <WatchSwitch id={repo.id} name={repo.full_name} watching />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {others.length > 0 && (
        <Card className="mt-5">
          <CardHeader
            title="Not watched"
            description={
              atLimit
                ? `You are watching ${account.limit}, which is the limit. Stop watching one to add another.`
                : "Switch one on to start scanning it."
            }
          />
          <ul className="divide-y divide-line">
            {others.map((repo) => (
              <li key={repo.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="[overflow-wrap:anywhere] font-mono text-[13px] text-muted">{repo.full_name}</span>
                  <RepoBadges repo={repo} />
                </span>
                <WatchSwitch id={repo.id} name={repo.full_name} watching={false} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

/* ---------------------------------------------------------------- Detail -- */

const PRIORITY_TONE = {
  urgent: "text-danger",
  high: "text-warning",
  medium: "text-subtle",
  low: "text-subtle",
} as const;

function AdvisoryRow({ finding }: { finding: Finding }) {
  const cve = finding.aliases?.find((a) => a.startsWith("CVE-"));
  const facts = [
    cve,
    finding.severity && finding.severity !== "unknown"
      ? finding.cvss != null
        ? `${finding.severity} ${finding.cvss.toFixed(1)}`
        : finding.severity
      : null,
    finding.kev ? "exploited in the wild" : null,
    finding.epss != null && finding.epss >= 0.01 ? `EPSS ${(finding.epss * 100).toFixed(1)}%` : null,
    finding.kind === "vulnerability" ? (finding.fixedIn ? `fixed in ${finding.fixedIn}` : "no fix yet") : null,
  ].filter(Boolean);

  return (
    <li className="py-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[12px]">
        {finding.url ? (
          <a href={finding.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-fg underline hover:text-accent">
            {finding.sourceId ?? finding.kind}
          </a>
        ) : (
          <span className="font-semibold">{finding.sourceId ?? finding.kind}</span>
        )}
        <span className="text-subtle">{facts.join("  ·  ")}</span>
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{finding.summary}</p>
    </li>
  );
}

function Entry({ entry }: { entry: PackageReport }) {
  const meta: string[] = [];
  if (entry.package) meta.push(`${entry.direct ? "direct" : "transitive"}${entry.scope === "dev" ? ", dev only" : ""}`);
  if (entry.kev) meta.push("exploited in the wild");
  if (entry.versions.length > 1) meta.push(`installed: ${entry.versions.join(", ")}`);
  if (entry.manifest) meta.push(entry.manifest);

  return (
    <li className="px-5 py-5">
      <p className="font-mono text-[12px]">
        <span className={cx("font-semibold", PRIORITY_TONE[entry.priority])}>[{entry.priority}]</span>
      </p>
      <h3 className="mt-1 break-words text-[16px] font-semibold leading-snug tracking-tight">
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
            {entry.title}
          </a>
        ) : (
          entry.title
        )}
      </h3>
      {meta.length > 0 && <p className="mt-1 break-words font-mono text-[12px] text-subtle">{meta.join("  ·  ")}</p>}
      <p className="mt-2 text-[14px] leading-relaxed text-muted">{entry.action}</p>

      {entry.command && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface-sunken py-1.5 pl-3 pr-1.5">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] leading-6">
            <span className="select-none text-subtle">$ </span>
            {entry.command}
          </code>
          <CopyButton text={entry.command} label="Copy command" />
        </div>
      )}

      {entry.findings.length > 1 && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none font-mono text-[12px] text-accent hover:underline [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">show all {entry.findings.length} findings</span>
            <span className="hidden group-open:inline">hide findings</span>
          </summary>
          <ul className="mt-1 divide-y divide-line border-t border-line">
            {entry.findings.map((finding) => (
              <AdvisoryRow key={finding.key} finding={finding} />
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function RepoDetailView({
  repo,
  basePath = "/app",
  appUrl,
  badgeSrc,
  now = new Date(),
}: {
  repo: RepoDetail;
  basePath?: string;
  /** Absolute origin, for the badge snippet. */
  appUrl: string;
  /** Where the badge preview loads from. The demo passes an inline image. */
  badgeSrc?: string;
  now?: Date;
}) {
  const report = repo.report ?? [];
  const scanned = repo.scan_status === "ok" && repo.health_grade !== null;
  const stats = repo.stats;
  const facts = [
    stats.dependencies !== undefined
      ? `${stats.dependencies} dependencies${stats.direct !== undefined ? ` (${stats.direct} direct)` : ""}${
          stats.ecosystems?.length ? ` across ${stats.ecosystems.join(", ")}` : ""
        }`
      : null,
    stats.dependencies !== undefined ? `read from ${sourceLabel(stats)}` : null,
    repo.scanned_at ? `scanned ${timeAgo(repo.scanned_at, now)}` : null,
  ].filter(Boolean);

  return (
    <Page>
      <ScanPoller active={repo.watching && repo.scan_status === "pending"} />

      <Link href={`${basePath}/repos`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" />
        Repos
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <GradeMark repo={repo} large />
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="[overflow-wrap:anywhere] font-mono text-[20px] font-semibold tracking-tight sm:text-[22px]">
                {repo.full_name}
              </span>
              <RepoBadges repo={repo} />
            </h1>
            <p className="mt-1 text-[14px] text-muted">
              {scanned
                ? `${repo.health_score}/100  ·  ${countsLabel(repo.counts) || "nothing to fix"}`
                : statusLine(repo, now)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScanButton id={repo.id} disabled={!repo.watching || repo.scan_status === "pending"} />
          <a
            href={`https://github.com/${repo.full_name}`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass("ghost", "sm")}
          >
            GitHub
            <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>

      {facts.length > 0 && <p className="mt-4 break-words font-mono text-[12px] text-subtle">{facts.join("  ·  ")}</p>}

      {repo.scan_status === "failed" && (
        <p className="mt-5 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[14px] text-danger" role="alert">
          {repo.scan_error ?? "The last scan failed."}
          {report.length > 0 && " What is shown below is from the last scan that worked."}
        </p>
      )}

      <Card className="mt-6">
        <CardHeader
          title={report.length > 0 ? `${report.length} to fix` : "Findings"}
          description={report.length > 0 ? "One entry per package, most pressing first." : undefined}
        />
        {report.length > 0 ? (
          <ul className="divide-y divide-line">
            {report.map((entry) => (
              <Entry key={entry.key} entry={entry} />
            ))}
          </ul>
        ) : scanned ? (
          <EmptyState
            icon={<ShieldCheck className="size-6" />}
            title="Nothing to fix"
            description="No known vulnerability, malicious package, deprecation or end-of-life runtime in what this repo depends on. It is checked again every day."
          />
        ) : (
          <EmptyState
            title={repo.scan_status === "pending" ? "Scanning" : "No report yet"}
            description={
              repo.scan_status === "pending"
                ? "Reading the manifests and checking each dependency. This page updates by itself."
                : "Run a scan to see what this repository depends on."
            }
          />
        )}
      </Card>

      {(repo.runtimes?.length ?? 0) > 0 && (
        <Card className="mt-5">
          <CardHeader title="Runtimes" description="Versions this repo pins, watched for end of life." />
          <ul className="divide-y divide-line">
            {repo.runtimes!.map((runtime) => (
              <li key={`${runtime.product}:${runtime.cycle}`} className="flex items-center justify-between gap-4 px-5 py-3">
                <span className="text-[14px] font-medium">
                  {runtimeName(runtime.product)} {runtime.cycle}
                </span>
                <span className="[overflow-wrap:anywhere] font-mono text-[12px] text-subtle">{runtime.source}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {repo.notes.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Notes from the scan" />
          <ul className="space-y-2 p-5 text-[13px] leading-relaxed text-muted">
            {repo.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-5">
        <CardHeader
          title="README badge"
          description="Shows this repo's grade. It gives the letter and the score, never what is wrong."
        />
        <div className="p-5">
          {/* Served by this app as an SVG, so next/image has nothing to optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={badgeSrc ?? badgeUrl("", repo.badge_token)} alt={`Dependency health badge for ${repo.full_name}`} height={20} />
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface-sunken py-1.5 pl-3 pr-1.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] leading-6">
              {badgeMarkdown(appUrl, repo.badge_token)}
            </code>
            <CopyButton text={badgeMarkdown(appUrl, repo.badge_token)} label="Copy badge markdown" />
          </div>
        </div>
      </Card>

      {repo.installation_id === null && (
        <div className="mt-6">
          <RemoveRepoButton id={repo.id} name={repo.full_name} redirectTo={`${basePath}/repos`} />
        </div>
      )}
    </Page>
  );
}
