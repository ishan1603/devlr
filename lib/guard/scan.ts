import { fetchJSON, mapLimit } from "@/lib/sources/http";
import { buildFindings, cvesIn, type LifecycleDate } from "@/lib/guard/findings";
import {
  fetchFiles,
  fetchRepoMeta,
  fetchSbom,
  listRelevantPaths,
  type GithubAuth,
  type RepoMeta,
} from "@/lib/guard/github";
import { healthOf, type Health } from "@/lib/guard/health";
import { fetchDeprecations, fetchEpss, fetchKev, type Deprecation, type Deprecations } from "@/lib/guard/intel";
import { buildInventory } from "@/lib/guard/inventory";
import { fetchAdvisory, mergeAdvisories, queryVulnerabilities } from "@/lib/guard/osv";
import { rollup, type PackageReport } from "@/lib/guard/rollup";
import { detectRuntimes, type DetectedRuntime } from "@/lib/guard/runtimes";
import { parseSpdx } from "@/lib/guard/sbom";
import { planUpgrades, type UpgradePlan } from "@/lib/guard/upgrade";
import { STACK } from "@/lib/topics/catalog";
import type { Advisory, Finding, Inventory, RepoRef } from "@/lib/guard/types";

/**
 * One repository, start to finish.
 *
 *   read      what does it depend on, at which exact versions?
 *   match     which advisories apply? (OSV decides, not us)
 *   context   is any of it being exploited, deprecated, or past end of life?
 *   report    findings, grouped by package, with one fix for each
 *
 * Reading and analysing are separate steps. `analyzeInventory` takes a
 * dependency list from anywhere (GitHub, a checkout on disk, a copy stored
 * from yesterday) and needs no access to the repository, which is what lets a
 * stored inventory be re-checked every day without touching GitHub again.
 *
 * Nothing here touches the database. The caller decides what to store and
 * what to tell the reader.
 */

export interface AnalyzeOptions {
  now?: Date;
  /** Known lifecycle dates. When omitted they are fetched from endoflife.date. */
  lifecycles?: LifecycleDate[];
  /**
   * Advisories fetched on earlier scans, by id. One is reused when OSV reports
   * the same modification time for it, and fetched again when it has changed.
   */
  knownAdvisories?: Map<string, Advisory>;
  /** A KEV set fetched earlier today. */
  kev?: Set<string>;
  /** Deprecation answers from earlier scans, with null meaning "checked, not deprecated". */
  knownDeprecations?: Map<string, Deprecation | null>;
}

export interface Analysis {
  /** Every problem found, one per package and advisory. This is what gets stored and diffed. */
  findings: Finding[];
  /** The same findings grouped into one entry per package. This is what gets shown. */
  packages: PackageReport[];
  health: Health;
  /** Advisories this scan had to fetch, for the caller to cache. */
  advisories: Advisory[];
  /** Deprecation answers this scan had to fetch, for the caller to cache. */
  deprecations: Map<string, Deprecation | null>;
  stats: {
    dependencies: number;
    direct: number;
    pinned: number;
    ecosystems: string[];
    advisoriesMatched: number;
  };
  /** Steps that failed without stopping the scan. The report is still valid, just thinner. */
  warnings: string[];
}

export interface ScanOptions extends AnalyzeOptions {
  auth?: GithubAuth;
}

export interface ScanResult extends Analysis {
  repo: RepoMeta;
  ref: string;
  inventory: Inventory;
  runtimes: DetectedRuntime[];
}

/** What a repository on GitHub depends on, and which runtimes it pins. */
export async function readRepository(
  repo: RepoRef,
  ref: string,
  auth: GithubAuth = {}
): Promise<{ inventory: Inventory; runtimes: DetectedRuntime[]; warnings: string[] }> {
  const warnings: string[] = [];
  const paths = await listRelevantPaths(repo, ref, auth);
  if (paths.truncated) warnings.push("This repository is very large. Only its first 80 manifests were read.");

  const runtimeFiles = await fetchFiles(repo, paths.runtimes, ref, auth).catch((err) => {
    warnings.push(`Runtime versions could not be read: ${err instanceof Error ? err.message : err}`);
    return [];
  });

  const [files, sbom] = await Promise.all([
    fetchFiles(repo, paths.manifests, ref, auth),
    // The graph is a bonus. Without it the lockfiles still answer for most repos.
    fetchSbom(repo, auth).catch((err) => {
      warnings.push(`The dependency graph could not be read: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
  ]);

  return {
    inventory: buildInventory(files, sbom ? parseSpdx(sbom) : null, { truncated: paths.truncated }),
    runtimes: detectRuntimes(runtimeFiles),
    warnings,
  };
}

const PRODUCT_NAMES = new Map(STACK.filter((s) => s.eol).map((s) => [s.eol!, s.name]));
PRODUCT_NAMES.set("alpine-linux", "Alpine Linux");
PRODUCT_NAMES.set("ubuntu", "Ubuntu");

/** Lifecycle dates for the detected runtimes, straight from endoflife.date. */
export async function fetchLifecycles(runtimes: DetectedRuntime[]): Promise<LifecycleDate[]> {
  const products = [...new Set(runtimes.map((r) => r.product))];
  const results = await mapLimit(products, 4, async (product) => {
    const cycles = await fetchJSON<{ cycle: string | number; eol?: string | boolean; link?: string | null }[]>(
      `https://endoflife.date/api/${product}.json`
    );
    const latest = cycles[0] ? String(cycles[0].cycle) : undefined;
    return cycles
      // Only announced dates. `false` means none has been set.
      .filter((c) => typeof c.eol === "string")
      .map((c) => ({
        product,
        cycle: String(c.cycle),
        eolDate: c.eol as string,
        name: PRODUCT_NAMES.get(product) ?? product,
        latest,
        link: c.link ?? `https://endoflife.date/${product}`,
      }));
  });
  return results.flatMap((r) => r.result ?? []);
}

/** Check a dependency list against every source, and say what to do about it. */
export async function analyzeInventory(
  inventory: Inventory,
  runtimes: DetectedRuntime[],
  options: AnalyzeOptions = {}
): Promise<Analysis> {
  const now = options.now ?? new Date();
  const warnings: string[] = [];

  // -- Match ----------------------------------------------------------------
  // If OSV cannot be reached there is no report to give: "no vulnerabilities
  // found" would be a lie. This one is allowed to fail the scan.
  const matches = await queryVulnerabilities(inventory.dependencies);
  const ids = [...new Set([...matches.byDependency.values()].flat())];

  const known = options.knownAdvisories ?? new Map<string, Advisory>();
  const current = (id: string) => {
    const cached = known.get(id);
    const modified = matches.modified.get(id);
    // Unchanged since it was fetched, as far as OSV says.
    return cached && (!modified || cached.modified === modified) ? cached : null;
  };

  const fetched = await mapLimit(ids.filter((id) => !current(id)), 8, (id) => fetchAdvisory(id));
  const fresh: Advisory[] = [];
  for (const { item, result, error } of fetched) {
    if (result) fresh.push(result);
    else warnings.push(`Advisory ${item} could not be loaded: ${error}`);
  }
  const all = [...ids.map(current).filter((a): a is Advisory => a !== null), ...fresh];
  const { merged, canonical } = mergeAdvisories(all);

  // -- Context --------------------------------------------------------------
  // Each of these enriches the report. None of them is allowed to sink it.
  const soft = async <T>(label: string, task: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await task();
    } catch (err) {
      warnings.push(`${label} unavailable: ${err instanceof Error ? err.message : err}`);
      return fallback;
    }
  };

  const noDeprecations: Deprecations = { deprecated: new Map(), learned: new Map() };
  const [kev, epss, deprecations, lifecycles] = await Promise.all([
    options.kev ? Promise.resolve(options.kev) : soft("CISA's exploited-vulnerability list", fetchKev, new Set<string>()),
    soft("EPSS scores", () => fetchEpss(cvesIn(merged)), new Map<string, number>()),
    soft("Deprecation data", () => fetchDeprecations(inventory.dependencies, options.knownDeprecations), noDeprecations),
    options.lifecycles
      ? Promise.resolve(options.lifecycles)
      : soft("Lifecycle dates", () => fetchLifecycles(runtimes), [] as LifecycleDate[]),
  ]);

  const findings = buildFindings({
    inventory,
    vulnerabilities: matches.byDependency,
    advisories: merged,
    canonical,
    kev,
    epss,
    deprecations: deprecations.deprecated,
    runtimes,
    lifecycles,
    now,
  });

  // -- One upgrade per package ----------------------------------------------
  // The target versions are put back to OSV. An advisory that only shows up
  // at a target (a newer release with a bug of its own) is fetched on demand.
  const byAnyId = new Map<string, Advisory>();
  for (const advisory of merged) for (const id of [advisory.id, ...advisory.aliases]) byAnyId.set(id, advisory);

  const plans = await soft(
    "Upgrade verification",
    () =>
      planUpgrades(findings, {
        query: async (dependencies) => (await queryVulnerabilities(dependencies)).byDependency,
        advisory: async (id) => {
          const cached = byAnyId.get(id) ?? known.get(id);
          if (cached) return cached;
          const loaded = await fetchAdvisory(id).catch(() => null);
          if (loaded) {
            byAnyId.set(id, loaded);
            fresh.push(loaded);
          }
          return loaded;
        },
      }),
    new Map<string, UpgradePlan>()
  );

  const packages = rollup(findings, plans);

  return {
    findings,
    packages,
    health: healthOf(packages),
    advisories: fresh,
    deprecations: deprecations.learned,
    stats: {
      dependencies: inventory.dependencies.length,
      direct: inventory.dependencies.filter((d) => d.direct).length,
      pinned: inventory.dependencies.filter((d) => d.pinned).length,
      ecosystems: [...new Set(inventory.dependencies.map((d) => d.ecosystem))].sort(),
      advisoriesMatched: merged.filter((a) => !a.withdrawn).length,
    },
    warnings,
  };
}

export async function scanRepository(repo: RepoRef, options: ScanOptions = {}): Promise<ScanResult> {
  const auth = options.auth ?? {};
  const meta = await fetchRepoMeta(repo, auth);
  const ref = repo.ref ?? meta.defaultBranch;

  const read = await readRepository(repo, ref, auth);
  const analysis = await analyzeInventory(read.inventory, read.runtimes, options);

  return {
    ...analysis,
    repo: meta,
    ref,
    inventory: read.inventory,
    runtimes: read.runtimes,
    warnings: [...read.warnings, ...analysis.warnings],
  };
}
