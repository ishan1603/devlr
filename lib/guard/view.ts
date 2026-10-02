import type { PackageReport } from "@/lib/guard/rollup";
import type { DetectedRuntime } from "@/lib/guard/runtimes";
import { STACK } from "@/lib/topics/catalog";

/**
 * Repo Guard as the app shows it.
 *
 * The shapes the screens take, the columns that fill them, and a few small
 * formatters. Nothing here runs on the server only, so pages, client
 * components and the demo all share it.
 */

export interface RepoCounts {
  urgent?: number;
  high?: number;
  medium?: number;
  low?: number;
}

export interface RepoStats {
  dependencies?: number;
  direct?: number;
  pinned?: number;
  ecosystems?: string[];
  method?: "sbom" | "lockfiles" | "both";
  manifests?: string[];
  findings?: number;
}

export interface RepoSummary {
  id: string;
  full_name: string;
  is_private: boolean;
  is_archived: boolean;
  watching: boolean;
  /** Null for a public repository added by name. */
  installation_id: number | null;
  scan_status: "pending" | "ok" | "failed";
  scan_error: string | null;
  scanned_at: string | null;
  health_score: number | null;
  health_grade: string | null;
  counts: RepoCounts;
  stats: RepoStats;
}

export interface RepoDetail extends RepoSummary {
  default_branch: string | null;
  badge_token: string;
  report: PackageReport[] | null;
  notes: string[];
  runtimes: DetectedRuntime[] | null;
}

export interface GithubAccount {
  installationId: number;
  login: string;
  type: "User" | "Organization";
  suspended: boolean;
}

export interface GuardAccount {
  /** Whether this deployment has a GitHub App at all. */
  githubConfigured: boolean;
  accounts: GithubAccount[];
  /** How many repositories one reader may have scanned. */
  limit: number;
}

export const REPO_LIST_COLUMNS =
  "id, full_name, is_private, is_archived, watching, installation_id, scan_status, scan_error, scanned_at, health_score, health_grade, counts, stats";

export const REPO_DETAIL_COLUMNS = `${REPO_LIST_COLUMNS}, default_branch, badge_token, report, notes, runtimes`;

/** "3 hours ago". Coarse on purpose: nobody needs the minute a scan ran. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** How the dependency list was obtained, in words. */
export function sourceLabel(stats: RepoStats): string {
  const manifests = (stats.manifests ?? []).filter((m) => m !== "GitHub dependency graph");
  const files =
    manifests.length > 3 ? `${manifests.slice(0, 2).join(", ")} and ${manifests.length - 2} more` : manifests.join(", ");
  if (stats.method === "sbom" || manifests.length === 0) return "GitHub's dependency graph";
  return stats.method === "both" ? `${files} and GitHub's dependency graph` : files;
}

/** Things to fix, as "2 urgent, 13 high". Empty when there is nothing. */
export function countsLabel(counts: RepoCounts): string {
  return (["urgent", "high", "medium", "low"] as const)
    .filter((level) => (counts[level] ?? 0) > 0)
    .map((level) => `${counts[level]} ${level}`)
    .join(", ");
}

export function badgeUrl(appUrl: string, token: string): string {
  return `${appUrl}/badge/${token}.svg`;
}

/** The line to paste into a README. */
export function badgeMarkdown(appUrl: string, token: string): string {
  return `[![Dependency health](${badgeUrl(appUrl, token)})](${appUrl})`;
}

const RUNTIME_NAMES = new Map<string, string>([
  ...STACK.filter((item) => item.eol).map((item) => [item.eol!, item.name] as [string, string]),
  ["alpine-linux", "Alpine Linux"],
  ["ubuntu", "Ubuntu"],
]);

/** "nodejs" is how endoflife.date spells it. "Node.js" is how people do. */
export function runtimeName(product: string): string {
  return RUNTIME_NAMES.get(product) ?? product;
}
