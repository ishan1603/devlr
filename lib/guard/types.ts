/**
 * Shared shapes for Repo Guard.
 *
 * The rule that runs through all of it: every fact here comes from a named
 * public source (OSV, CISA, FIRST, deps.dev, endoflife.date), and every
 * finding carries the id of the record it came from. A model is allowed to
 * rephrase an advisory for a reader. It is never asked whether a package is
 * vulnerable.
 */

/** Ecosystem names as OSV spells them, since OSV is what does the matching. */
export type Ecosystem =
  | "npm"
  | "PyPI"
  | "Go"
  | "crates.io"
  | "Maven"
  | "RubyGems"
  | "NuGet"
  | "Packagist"
  | "Pub"
  | "Hex"
  | "GitHub Actions";

export type Scope = "runtime" | "dev" | "unknown";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /**
   * False when `version` is a range ("^4.17.0") rather than a resolved
   * version. A range cannot be checked against an advisory, so these are
   * reported as unresolved instead of being guessed at.
   */
  pinned: boolean;
  /** Declared by the repo itself, as opposed to pulled in by something else. */
  direct: boolean;
  scope: Scope;
  /** Where it was read from, e.g. "package-lock.json". */
  manifest?: string;
}

export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";

export interface Advisory {
  /** OSV id: GHSA-..., PYSEC-..., RUSTSEC-..., MAL-..., GO-... */
  id: string;
  /** Other ids for the same issue, usually the CVE. */
  aliases: string[];
  summary: string;
  details: string;
  severity: Severity;
  /** CVSS base score, 0 to 10, when a v3 vector was published. */
  cvss: number | null;
  /** True for a package that is itself malware, not merely flawed. */
  malicious: boolean;
  published: string | null;
  modified: string | null;
  withdrawn: string | null;
  /** The page a reader should be sent to. */
  url: string;
  /**
   * Fixed versions per affected package, keyed `ecosystem:name`. One advisory
   * can cover several packages, each with its own fix.
   */
  fixes: Record<string, string[]>;
  /**
   * For advisories that only concern part of a module: the import paths that
   * are actually affected, keyed like `fixes`. Go's database records this. A
   * module can be "vulnerable" while the repo never imports the affected
   * package, and without call-graph analysis the honest thing is to say so.
   */
  imports?: Record<string, string[]>;
}

/** Exploit context for a CVE, from CISA and FIRST. */
export interface ExploitIntel {
  /** Listed in CISA's Known Exploited Vulnerabilities catalog. */
  kev: boolean;
  /** FIRST's EPSS: probability of exploitation in the next 30 days, 0 to 1. */
  epss: number | null;
}

export type FindingKind = "malicious" | "vulnerability" | "deprecated" | "eol" | "unresolved";

export type Priority = "urgent" | "high" | "medium" | "low";

export interface Finding {
  /** Stable identity within a repo: what makes "tell me once" possible. */
  key: string;
  kind: FindingKind;
  priority: Priority;
  /** 0 to 100, for ordering within a priority. */
  score: number;
  ecosystem?: Ecosystem;
  package?: string;
  version?: string;
  direct?: boolean;
  scope?: Scope;
  /** The lockfile it was read from, which is also what decides the fix command. */
  manifest?: string;
  /** Advisory id, or the lifecycle product for an EOL finding. */
  sourceId?: string;
  aliases?: string[];
  severity?: Severity;
  cvss?: number | null;
  kev?: boolean;
  epss?: number | null;
  title: string;
  /** One or two plain sentences. From the source, or a reviewed rewrite of it. */
  summary: string;
  /**
   * Import paths the advisory is limited to, when it names any. A Go module
   * can match while the repo never imports the affected package.
   */
  imports?: string[];
  /** The smallest version that fixes it, when one exists. */
  fixedIn?: string;
  /** A command the reader can paste. */
  fix?: string;
  url?: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch or commit. Defaults to the repository's default branch. */
  ref?: string;
}

export interface Inventory {
  dependencies: Dependency[];
  /**
   * How the list was obtained, shown to the reader so they can judge it:
   * the repo's lockfiles, GitHub's dependency graph, or lockfiles with the
   * graph filling in ecosystems they do not cover.
   */
  method: "sbom" | "lockfiles" | "both";
  manifests: string[];
  /** Things worth telling the reader that are not findings about a package. */
  notes: string[];
}
