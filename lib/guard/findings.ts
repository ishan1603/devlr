import { cleanProse } from "@/lib/ai/style";
import { fixCommand } from "@/lib/guard/fix";
import { cveOf, deprecationKey, intelFor, type Deprecation } from "@/lib/guard/intel";
import { dependencyKey } from "@/lib/guard/osv";
import { comparePriority, prioritize } from "@/lib/guard/priority";
import { packageKey } from "@/lib/guard/purl";
import { compareVersions, pickFix } from "@/lib/guard/versions";
import type { DetectedRuntime } from "@/lib/guard/runtimes";
import type { Advisory, Dependency, Finding, Inventory, Priority } from "@/lib/guard/types";

/**
 * Turning scan data into findings.
 *
 * Everything that reaches here has already been fetched: the dependency list,
 * which advisories apply, exploit context, deprecations, lifecycles. This
 * module only decides how that is presented: one finding per problem, a
 * stable key for each, and an order. It makes no network calls and has no
 * clock of its own, so every decision in it is covered by tests.
 */

export interface LifecycleDate {
  product: string;
  cycle: string;
  /** YYYY-MM-DD. */
  eolDate: string;
  /** Display name, e.g. "Node.js". */
  name?: string;
  /** The newest cycle, to move to. */
  latest?: string;
  link?: string;
}

export interface FindingsInput {
  inventory: Inventory;
  /** dependencyKey -> advisory ids, from OSV. */
  vulnerabilities: Map<string, string[]>;
  /** Already merged, so each real-world issue appears once. */
  advisories: Advisory[];
  /** Every advisory id (including merged-away ones) -> the id that survived. */
  canonical: Map<string, string>;
  kev: Set<string>;
  epss: Map<string, number>;
  /** "ecosystem:name@version" -> deprecation notice. */
  deprecations: Map<string, Deprecation>;
  runtimes: DetectedRuntime[];
  lifecycles: LifecycleDate[];
  now: Date;
}

/** How long before a date end-of-life starts being worth mentioning. */
export const EOL_HORIZON_DAYS = 90;

function daysUntil(date: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

/**
 * Cut on a word boundary, and say so. Some databases write a paragraph where
 * a title goes.
 */
export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > max * 0.6 ? space : max).replace(/[,;:.\s]+$/, "")}...`;
}

function sentence(text: string): string {
  const clean = cleanProse(text.replace(/\s+/g, " "));
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

/**
 * Pick the dependency a finding should be reported against, when the same
 * package is present in several versions: prefer one the repo chose itself,
 * then one that ships, then the oldest (the one furthest from a fix).
 */
function representative(deps: Dependency[]): Dependency {
  return deps.slice().sort(
    (a, b) =>
      Number(b.direct) - Number(a.direct) ||
      Number(a.scope === "dev") - Number(b.scope === "dev") ||
      compareVersions(a.version, b.version)
  )[0];
}

/**
 * Go advisories are filed against a module but usually concern one package
 * inside it. We match on the module, so this may not affect the repo at all,
 * and the reader should be told which import to look for.
 */
export function importCaveat(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  const shown = paths.slice(0, 2).join(" or ");
  return ` Only code that imports ${shown}${paths.length > 2 ? " (or related packages)" : ""} is affected.`;
}

export function buildFindings(input: FindingsInput): Finding[] {
  const findings: Finding[] = [];
  const advisoryById = new Map(input.advisories.map((a) => [a.id, a]));

  // -- Vulnerabilities and malicious packages -------------------------------
  // Grouped by (package, advisory), not (package version, advisory): if three
  // versions of a package all have the same bug, that is one thing to fix.
  const affected = new Map<string, { advisory: Advisory; deps: Dependency[] }>();
  for (const dependency of input.inventory.dependencies) {
    for (const id of input.vulnerabilities.get(dependencyKey(dependency)) ?? []) {
      const advisory = advisoryById.get(input.canonical.get(id) ?? id);
      // Withdrawn means the database retracted it. It is not a finding.
      if (!advisory || advisory.withdrawn) continue;
      const key = `${packageKey(dependency.ecosystem, dependency.name)}|${advisory.id}`;
      const group = affected.get(key) ?? { advisory, deps: [] };
      if (!group.deps.includes(dependency)) group.deps.push(dependency);
      affected.set(key, group);
    }
  }

  for (const { advisory, deps } of affected.values()) {
    const dependency = representative(deps);
    const pkgKey = packageKey(dependency.ecosystem, dependency.name);
    const ids = [advisory.id, ...advisory.aliases];
    const intel = intelFor(ids, input.kev, input.epss);
    const fixedIn = advisory.malicious ? null : pickFix(dependency.version, advisory.fixes[pkgKey] ?? []);
    const kind = advisory.malicious ? "malicious" : "vulnerability";

    const { priority, score } = prioritize({
      kind,
      severity: advisory.severity,
      kev: intel.kev,
      epss: intel.epss,
      direct: dependency.direct,
      scope: dependency.scope,
      hasFix: fixedIn !== null,
    });

    findings.push({
      // The version is left out of the key on purpose: moving from one
      // vulnerable version to another is the same finding, not a new alert.
      key: `${kind}:${pkgKey}:${advisory.id}`,
      kind,
      priority,
      score,
      ecosystem: dependency.ecosystem,
      package: dependency.name,
      version: dependency.version,
      direct: dependency.direct,
      scope: dependency.scope,
      manifest: dependency.manifest,
      sourceId: advisory.id,
      aliases: advisory.aliases,
      severity: advisory.severity,
      cvss: advisory.cvss,
      kev: intel.kev,
      epss: intel.epss,
      title: advisory.malicious
        ? `${dependency.name} ${dependency.version} is a known malicious package`
        : `${dependency.name} ${dependency.version}: ${shorten(advisory.summary.replace(/[.\s]+$/, ""), 110)}`,
      summary: sentence(advisory.summary) + importCaveat(advisory.imports?.[pkgKey]),
      imports: advisory.imports?.[pkgKey],
      fixedIn: fixedIn ?? undefined,
      // For malware there is no safe version to move to. The fix is removal.
      fix: advisory.malicious ? undefined : (fixCommand(dependency, fixedIn) ?? undefined),
      url: advisory.url,
    });
  }

  // -- Deprecated ------------------------------------------------------------
  for (const dependency of input.inventory.dependencies) {
    const notice = input.deprecations.get(deprecationKey(dependency));
    if (!notice) continue;
    const { priority, score } = prioritize({ kind: "deprecated", scope: dependency.scope, direct: dependency.direct });
    findings.push({
      key: `deprecated:${packageKey(dependency.ecosystem, dependency.name)}`,
      kind: "deprecated",
      priority,
      score,
      ecosystem: dependency.ecosystem,
      package: dependency.name,
      version: dependency.version,
      direct: dependency.direct,
      scope: dependency.scope,
      manifest: dependency.manifest,
      title: `${dependency.name} ${dependency.version} is deprecated`,
      // The maintainer's own words, which usually name the replacement.
      summary: sentence(notice.reason) || "Its maintainers have marked this version deprecated.",
    });
  }

  // -- End of life -----------------------------------------------------------
  for (const runtime of input.runtimes) {
    const lifecycle = input.lifecycles.find((l) => l.product === runtime.product && l.cycle === runtime.cycle);
    if (!lifecycle) continue;
    const daysLeft = daysUntil(lifecycle.eolDate, input.now);
    if (daysLeft > EOL_HORIZON_DAYS) continue;

    const { priority, score } = prioritize({ kind: "eol", daysLeft });
    const name = lifecycle.name ?? runtime.product;
    const when =
      daysLeft < 0
        ? `reached end of life on ${lifecycle.eolDate}`
        : daysLeft === 0
          ? "reaches end of life today"
          : `reaches end of life on ${lifecycle.eolDate}, in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`;

    findings.push({
      key: `eol:${runtime.product}:${runtime.cycle}`,
      kind: "eol",
      priority,
      score,
      sourceId: runtime.product,
      version: runtime.cycle,
      title: `${name} ${runtime.cycle} ${when}`,
      summary:
        `${runtime.source} pins ${name} ${runtime.version}. ` +
        (daysLeft < 0 ? "It no longer receives security fixes." : "After that date it stops receiving security fixes.") +
        (lifecycle.latest && lifecycle.latest !== runtime.cycle ? ` The current release is ${lifecycle.latest}.` : ""),
      url: lifecycle.link ?? `https://endoflife.date/${runtime.product}`,
    });
  }

  // -- Could not be checked --------------------------------------------------
  // One finding per manifest rather than one per package: the problem is the
  // missing lockfile, and it has one fix.
  const unpinnedByManifest = new Map<string, Dependency[]>();
  for (const dependency of input.inventory.dependencies) {
    if (dependency.pinned) continue;
    // A workflow's `uses: actions/checkout@v4` is a floating tag by design.
    // There is no lockfile to commit for it, so it is not reported as a gap.
    if (dependency.ecosystem === "GitHub Actions") continue;
    const manifest = dependency.manifest ?? "the dependency graph";
    unpinnedByManifest.set(manifest, [...(unpinnedByManifest.get(manifest) ?? []), dependency]);
  }
  for (const [manifest, deps] of unpinnedByManifest) {
    const { priority, score } = prioritize({ kind: "unresolved" });
    const names = deps.slice(0, 3).map((d) => d.name).join(", ");
    const one = deps.length === 1;
    findings.push({
      key: `unresolved:${manifest}`,
      kind: "unresolved",
      priority,
      score,
      title: `${deps.length} ${one ? "dependency" : "dependencies"} in ${manifest} could not be checked`,
      summary:
        `${one ? "It is declared as a version range" : "They are declared as version ranges"} with no lockfile ` +
        `(${names}${deps.length > 3 ? ", and others" : ""}), so there is no exact version to match against advisories. ` +
        `Commit a lockfile to have ${one ? "it" : "them"} checked.`,
    });
  }

  return findings.sort(comparePriority);
}

export interface FindingsDiff {
  /** Present now, not before. These are what a reader gets told about. */
  added: Finding[];
  /** Present before, gone now: fixed, or the package was removed. */
  resolvedKeys: string[];
  /** Still present. Not re-announced. */
  unchanged: Finding[];
  /** Present before but now more pressing, e.g. it entered CISA's catalog. */
  escalated: Finding[];
}

const RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Compare a scan with what was known before.
 *
 * "Tell me once" lives here. A finding the reader has already been told about
 * stays quiet on every later scan, with one exception: if it has become
 * urgent since (say CISA added it to the exploited list), that is news.
 */
export function diffFindings(
  previous: { key: string; priority: Priority }[],
  current: Finding[]
): FindingsDiff {
  const before = new Map(previous.map((p) => [p.key, p.priority]));
  const now = new Set(current.map((f) => f.key));

  const added: Finding[] = [];
  const unchanged: Finding[] = [];
  const escalated: Finding[] = [];
  for (const finding of current) {
    const was = before.get(finding.key);
    if (was === undefined) added.push(finding);
    else if (finding.priority === "urgent" && RANK[finding.priority] < RANK[was]) escalated.push(finding);
    else unchanged.push(finding);
  }

  return {
    added,
    unchanged,
    escalated,
    resolvedKeys: [...before.keys()].filter((key) => !now.has(key)),
  };
}

/** CVE ids across a set of advisories, for the EPSS lookup. */
export function cvesIn(advisories: Advisory[]): string[] {
  const out = new Set<string>();
  for (const advisory of advisories) {
    const cve = cveOf([advisory.id, ...advisory.aliases]);
    if (cve) out.add(cve);
  }
  return [...out];
}
