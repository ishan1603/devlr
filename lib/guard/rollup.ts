import { importCaveat } from "@/lib/guard/findings";
import { planFix, type Fix } from "@/lib/guard/fix";
import { comparePriority } from "@/lib/guard/priority";
import { packageKey } from "@/lib/guard/purl";
import { draftPlan, type UpgradePlan } from "@/lib/guard/upgrade";
import { compareVersions } from "@/lib/guard/versions";
import type { Ecosystem, Finding, FindingKind, Priority, Scope, Severity } from "@/lib/guard/types";

/**
 * Findings, grouped into things to do.
 *
 * A scan of a real project produced 118 findings, 25 of them for one package.
 * Each is true and each matters for "tell me once", so they are kept as they
 * are. But nobody acts on 25 advisories. They act on one package, with one
 * upgrade. This is the view a reader is shown: one entry per package, carrying
 * its findings, with a single next step.
 *
 * Findings that are not about a package (a runtime reaching end of life, a
 * manifest with no lockfile) pass through as entries of their own.
 */

export interface PackageReport {
  /** `ecosystem:name` for a package, or the finding's own key for anything else. */
  key: string;
  /** The kind of its most pressing finding. */
  kind: FindingKind;
  priority: Priority;
  score: number;
  title: string;
  /** What to do about it, in a sentence or two. */
  action: string;
  /** A command to paste, when there is one that reliably does the job. */
  command?: string;
  /** Where to read more: the advisory's page, when the entry has exactly one. */
  url?: string;

  ecosystem?: Ecosystem;
  package?: string;
  /** Installed versions with something wrong, oldest first. Usually one. */
  versions: string[];
  direct?: boolean;
  scope?: Scope;
  manifest?: string;

  /** Advisory count by severity, for the vulnerabilities in this entry. */
  severities: Partial<Record<Severity, number>>;
  /** At least one of them is in CISA's exploited list. */
  kev: boolean;
  upgrade?: UpgradePlan;
  /** Most pressing first. */
  findings: Finding[];
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "moderate", "low", "unknown"];

function severitySummary(severities: Partial<Record<Severity, number>>): string {
  const parts = SEVERITY_ORDER.filter((s) => s !== "unknown" && severities[s]).map((s) => `${severities[s]} ${s}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** What to say about a package the repo did not ask for itself. */
function nestedNote(fix: Fix | null, breaking: boolean): string {
  if (fix?.kind === "upgrade") return "";
  if (fix?.kind === "trace") {
    return " It is pulled in by another package. The command shows which one, and that is the one to upgrade.";
  }
  if (fix?.kind === "refresh") {
    return breaking
      ? " It is pulled in by another package, and this fix is a breaking release its parent may not allow. If the command does not move it, upgrade the parent."
      : " It is pulled in by another package. The command re-resolves it within the range its parent allows.";
  }
  return " It is pulled in by another package, so the parent is what needs upgrading.";
}

/** The sentence that goes with an upgrade plan. It claims only what was checked. */
function upgradeAction(plan: UpgradePlan, vulnerabilities: Finding[], direct: boolean | undefined, fix: Fix | null): string {
  const count = vulnerabilities.length;
  if (!plan.target) {
    return count === 1
      ? "No fixed version has been published yet."
      : "No fixed version has been published for any of them yet.";
  }

  // Of the advisories here, how many are gone at the target version?
  const still = new Set(plan.remaining);
  const cleared = vulnerabilities.filter(
    (f) => !still.has(f.sourceId ?? "") && !(f.aliases ?? []).some((alias) => still.has(alias))
  ).length;
  const others = plan.remaining.length - (count - cleared);

  let text: string;
  if (plan.verified || (cleared === count && others <= 0)) {
    text = count === 1 || !plan.verified ? `Upgrade to ${plan.target}.` : `Upgrade to ${plan.target}. That clears all ${count}.`;
  } else if (cleared === count) {
    text = `${plan.target} fixes ${count === 1 ? "this" : "these"}, but it has other known advisories of its own. Read them before upgrading.`;
  } else if (cleared > 0) {
    text = `Upgrade to ${plan.target}, which fixes ${cleared} of ${count}. The ${count - cleared === 1 ? "other still applies" : "others still apply"} at that version.`;
  } else {
    return "No published version fixes this yet.";
  }

  // A changelog is the reader's to check only for a package they chose.
  if (direct === false) text += nestedNote(fix, plan.breaking);
  else if (plan.breaking) text += " That is a breaking release, so read its changelog first.";
  return text;
}

/**
 * Group findings into one entry per package.
 *
 * `plans` comes from planUpgrades. A package with no plan there gets one
 * drafted from its own findings, which is the same target without OSV's
 * confirmation, and is worded accordingly.
 */
export function rollup(findings: Finding[], plans: Map<string, UpgradePlan> = new Map()): PackageReport[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.ecosystem && finding.package ? packageKey(finding.ecosystem, finding.package) : finding.key;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  const reports: PackageReport[] = [];
  for (const [key, unsorted] of groups) {
    const group = unsorted.slice().sort(comparePriority);
    const top = group[0];

    if (!top.package || !top.ecosystem) {
      reports.push({
        key,
        kind: top.kind,
        priority: top.priority,
        score: top.score,
        title: top.title,
        action: top.summary,
        url: top.url,
        versions: top.version ? [top.version] : [],
        severities: {},
        kev: false,
        findings: group,
      });
      continue;
    }

    const vulnerabilities = group.filter((f) => f.kind === "vulnerability");
    const severities: Partial<Record<Severity, number>> = {};
    for (const f of vulnerabilities) severities[f.severity ?? "unknown"] = (severities[f.severity ?? "unknown"] ?? 0) + 1;

    const malicious = top.kind === "malicious";
    const plan = vulnerabilities.length > 0 ? (plans.get(key) ?? draftPlan(vulnerabilities)) : undefined;

    let title = top.title;
    let action = top.summary;
    let command: string | undefined;
    if (malicious) {
      // There is no safe version of malware to move to.
      action = "Remove it now, then rotate any credentials the machine or build that installed it could reach.";
    } else if (plan) {
      if (vulnerabilities.length > 1) {
        title = `${top.package} ${top.version} has ${vulnerabilities.length} known vulnerabilities${severitySummary(severities)}`;
      } else {
        title = vulnerabilities[0].title;
      }
      const fix = planFix(
        { ecosystem: top.ecosystem, name: top.package, manifest: top.manifest, direct: top.direct ?? false },
        plan.target,
        { breaking: plan.breaking }
      );
      action = upgradeAction(plan, vulnerabilities, top.direct, fix);
      // With one advisory its scope can be stated. With several it differs per advisory.
      if (vulnerabilities.length === 1) action += importCaveat(vulnerabilities[0].imports);
      if (group.some((f) => f.kind === "deprecated")) action += " This version is also deprecated.";
      command = fix?.command;
    }

    reports.push({
      key,
      kind: top.kind,
      priority: top.priority,
      score: top.score,
      title,
      action,
      command,
      // One advisory has one page to read. Several are listed with the findings.
      url: vulnerabilities.length === 1 ? vulnerabilities[0].url : group.length === 1 ? top.url : undefined,
      ecosystem: top.ecosystem,
      package: top.package,
      versions: [...new Set(group.map((f) => f.version).filter((v): v is string => Boolean(v)))].sort(compareVersions),
      direct: top.direct,
      scope: top.scope,
      manifest: top.manifest,
      severities,
      kev: group.some((f) => f.kev),
      upgrade: plan,
      findings: group,
    });
  }

  return reports.sort(comparePriority);
}
