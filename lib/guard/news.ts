import { SUBJECT_MAX_LENGTH, fitSubject } from "@/lib/ai/style";
import { comparePriority } from "@/lib/guard/priority";
import type { PackageReport } from "@/lib/guard/rollup";
import type { GuardEntry, GuardRepoSummary, GuardSection } from "@/lib/delivery/issue";

/**
 * What, out of everything a scan found, is news for this reader.
 *
 * The scan has already decided what is wrong, how pressing it is and what to
 * do. This decides what to say about it today. A package is news when at
 * least one of its findings has not been announced yet, and once it has been,
 * it stays quiet for as long as nothing about it changes.
 *
 * No text here is written by a model. A wrong word about a security issue is
 * worse than a plain one. And nothing here touches the database, so every
 * rule about what gets announced is covered by tests.
 */

/**
 * Entries shown in full. The rest are named, with a link to the app. A regular
 * issue has reading to get to, so it shows fewer than the alert, which is
 * about nothing else.
 */
const DETAILED = 3;
const DETAILED_IN_ALERT = 5;
const ALSO_NAMED = 8;

export interface GuardRepo {
  id: string;
  fullName: string;
  grade: string | null;
  score: number | null;
  report: PackageReport[];
}

export interface PendingFinding {
  id: number;
  repoId: string;
  key: string;
  /** Urgent now, and the reader has not been told so. */
  urgent: boolean;
}

/**
 * A report entry in a few words, short enough for a subject line.
 *
 * Which package, in which repo, and how bad, because that is the order in
 * which someone decides whether to open the email. A subject has about sixty
 * characters, and cutting one off mid-fact ("31 advisories, 3") is worse than
 * saying less. So this builds the line a few ways, from the most complete to
 * the shortest, and takes the first that fits whole: the owner is dropped
 * from the repository name before the severity is.
 */
export function guardHeadline(entry: PackageReport, repo: string): string {
  const short = repo.split("/").pop() ?? repo;
  const firstThatFits = (candidates: string[]): string =>
    candidates.find((line) => line.length <= SUBJECT_MAX_LENGTH) ?? fitSubject(candidates[candidates.length - 1]);
  /** A line that names where, tried with the full repository name and then without its owner. */
  const located = (build: (where: string) => string, ...shorter: string[]) =>
    firstThatFits([build(repo), build(short), ...shorter]);

  if (!entry.package) {
    // A runtime or a manifest. Its title already says what is wrong; it only
    // needs to say where.
    return entry.kind === "unresolved"
      ? located((where) => `${where}: ${entry.title}`)
      : located((where) => `${entry.title} (${where})`, entry.title);
  }

  const name = entry.package;
  const what = `${name} ${entry.findings[0]?.version ?? entry.versions[0] ?? ""}`.trim();
  if (entry.kind === "malicious") {
    return located((where) => `${what} in ${where} is known malware`, `${what} is known malware`, `${name} is known malware`);
  }

  const vulnerabilities = entry.findings.filter((f) => f.kind === "vulnerability");
  if (vulnerabilities.length === 0) {
    return located((where) => `${what} in ${where} is deprecated`, `${what} is deprecated`, `${name} is deprecated`);
  }
  if (entry.kev) {
    return located((where) => `${what} in ${where} is being exploited`, `${what} is being exploited`, `${name} is being exploited`);
  }

  const worst = (["critical", "high", "moderate", "low"] as const).find((s) => entry.severities[s]);
  const count = vulnerabilities.length === 1 ? (worst ? `${worst} advisory` : "new advisory") : `${vulnerabilities.length} advisories`;
  const how = vulnerabilities.length > 1 && worst ? `${count}, ${entry.severities[worst]} ${worst}` : count;
  return located((where) => `${what} in ${where}: ${how}`, `${what}: ${how}`, `${name}: ${how}`, `${name}: ${count}`);
}

function toEntry(entry: PackageReport, repo: GuardRepo, fresh: number, base: string): GuardEntry {
  const meta: string[] = [];
  if (entry.package) meta.push(`${entry.direct ? "direct" : "transitive"}${entry.scope === "dev" ? ", dev only" : ""}`);
  if (entry.kev) meta.push("exploited in the wild");
  // Only worth saying when some of it was announced before.
  if (fresh < entry.findings.length) meta.push(`${fresh} new`);

  return {
    ref: `${repo.id}:${entry.key}`,
    repo: repo.fullName,
    priority: entry.priority,
    title: entry.title,
    headline: guardHeadline(entry, repo.fullName),
    action: entry.action,
    command: entry.command,
    url: entry.url ?? `${base}/app/repos/${repo.id}`,
    meta,
  };
}

export interface GuardNews {
  section: GuardSection | null;
  /** One per entry shown or named, for the delivery record. */
  refs: string[];
  /**
   * Finding ids this settles. With a section, they are marked as told once the
   * email has gone. Without one, they are findings that no report shows any
   * more, and there is nothing to send.
   */
  findingIds: number[];
}

/**
 * Turn a reader's reports and their unannounced findings into a section.
 *
 * `urgentOnly` builds the alert that goes out on its own: only what is urgent
 * and has not been announced as urgent. Otherwise everything unannounced goes
 * in, most pressing first.
 */
export function buildGuardNews(
  repos: GuardRepo[],
  pending: PendingFinding[],
  options: { urgentOnly?: boolean; baseUrl: string }
): GuardNews {
  const byRepo = new Map<string, Map<string, PendingFinding>>();
  for (const finding of pending) {
    const keys = byRepo.get(finding.repoId) ?? new Map<string, PendingFinding>();
    keys.set(finding.key, finding);
    byRepo.set(finding.repoId, keys);
  }

  // An entry is announced whole. If one of a package's advisories is urgent,
  // the alert shows the package with all of them, and all of them count as
  // told: the reader should not get the same package again tomorrow for the
  // advisories that were merely high.
  const news: { entry: PackageReport; repo: GuardRepo; mine: PendingFinding[] }[] = [];
  for (const repo of repos) {
    const keys = byRepo.get(repo.id);
    if (!keys) continue;
    for (const entry of repo.report) {
      const mine = entry.findings.map((f) => keys.get(f.key)).filter((p): p is PendingFinding => p !== undefined);
      if (mine.length === 0) continue;
      if (options.urgentOnly && !mine.some((p) => p.urgent)) continue;
      news.push({ entry, repo, mine });
    }
  }

  // What this settles. Everything shown, plus anything unannounced that no
  // report shows any more: leaving those pending would bring the scheduler
  // back for them every day, with nothing to send.
  const considered = new Set(repos.map((r) => r.id));
  const shownIds = new Set(news.flatMap(({ mine }) => mine.map((p) => p.id)));
  const inSomeEntry = new Set(repos.flatMap((r) => r.report.flatMap((e) => e.findings.map((f) => `${r.id}:${f.key}`))));
  const findingIds = pending
    .filter((p) => considered.has(p.repoId))
    .filter((p) => {
      if (shownIds.has(p.id)) return true;
      const orphaned = !inSomeEntry.has(`${p.repoId}:${p.key}`);
      // The alert leaves what it does not show for the regular issue.
      return options.urgentOnly ? orphaned && p.urgent : true;
    })
    .map((p) => p.id);

  if (news.length === 0) return { section: null, refs: [], findingIds };

  news.sort((a, b) => comparePriority(a.entry, b.entry) || a.repo.fullName.localeCompare(b.repo.fullName));
  const detailed = options.urgentOnly ? DETAILED_IN_ALERT : DETAILED;
  const shown = news.slice(0, detailed);
  const rest = news.slice(detailed);

  const names = [...new Set(rest.map(({ entry }) => entry.package ?? entry.title))];
  const also = names.slice(0, ALSO_NAMED);
  if (names.length > ALSO_NAMED) also.push(`${names.length - ALSO_NAMED} more`);

  const involved = new Map(news.map(({ repo }) => [repo.id, repo]));
  const summaries: GuardRepoSummary[] = [...involved.values()]
    .filter((repo) => repo.grade !== null && repo.score !== null)
    .map((repo) => ({
      fullName: repo.fullName,
      grade: repo.grade!,
      score: repo.score!,
      toFix: repo.report.length,
      url: `${options.baseUrl}/app/repos/${repo.id}`,
    }))
    // Worst first: that is the one to open.
    .sort((a, b) => a.score - b.score || a.fullName.localeCompare(b.fullName));

  return {
    section: {
      type: "guard",
      module: "repo_guard",
      label: "repo guard",
      title: options.urgentOnly ? "Needs fixing now" : "In your repositories",
      repos: summaries,
      entries: shown.map(({ entry, repo, mine }) => toEntry(entry, repo, mine.length, options.baseUrl)),
      also,
      url: `${options.baseUrl}/app/repos`,
    },
    refs: news.map(({ entry, repo }) => `${repo.id}:${entry.key}`),
    findingIds,
  };
}

/**
 * Subject, preheader and opening line for an issue led by Repo Guard.
 *
 * Built from the scan's own words. The subject avoids "urgent" and its
 * relatives on purpose: spam filters weigh that vocabulary, and the fact
 * itself ("is being exploited", "3 critical") carries the urgency better.
 */
export function guardCopy(section: GuardSection, urgent: boolean): { subject: string; preheader: string; intro: string } {
  const lead = section.entries[0];
  const others = section.entries.length - 1 + section.also.length;
  const count = section.entries.length + section.also.length;

  const repos = new Set(section.entries.map((e) => e.repo));
  const where = repos.size === 1 ? lead.repo : `${repos.size} repositories`;

  let intro: string;
  if (urgent) {
    intro =
      `${count === 1 ? "This was" : "These were"} found in ${where} and should not wait for your next issue. ` +
      (lead.command ? "The fix is a command you can paste." : "What to do is below.");
  } else {
    intro =
      count === 1
        ? `One thing needs attention in ${where}.`
        : `${count} things need attention in ${where}. Most pressing first.`;
  }

  // The first sentence of the advice is the advice. A version number has dots
  // in it but never one followed by a space, so this does not cut "15.5.24".
  const firstStep = lead.action.split(/(?<=[.!?])\s+/)[0];
  return {
    subject: fitSubject(lead.headline),
    preheader: others > 0 ? `${firstStep} Plus ${others} more below.` : firstStep,
    intro,
  };
}
