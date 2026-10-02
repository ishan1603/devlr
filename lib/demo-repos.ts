import report from "@/lib/demo-report.json";
import type { Issue } from "@/lib/delivery/issue";
import { healthOf } from "@/lib/guard/health";
import { buildGuardNews, guardCopy } from "@/lib/guard/news";
import type { PackageReport } from "@/lib/guard/rollup";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import type { GuardAccount, RepoDetail, RepoSummary } from "@/lib/guard/view";

/**
 * Repositories for the /demo area.
 *
 * The first one's report is real: a scan of this project's own `main` branch
 * on 2026-10-01, trimmed to six of its entries. The advisories, versions and
 * fixes in it are what OSV returned that day. It is the report that prompted
 * most of the upgrades on this branch.
 */

const REPORT = report as unknown as PackageReport[];
const health = healthOf(REPORT);

const base = {
  is_private: false,
  is_archived: false,
  watching: true,
  installation_id: 41_207_733,
  scan_status: "ok" as const,
  scan_error: null,
};

export const DEMO_ACCOUNT: GuardAccount = {
  githubConfigured: true,
  accounts: [{ installationId: 41_207_733, login: "ada-lovelace", type: "User", suspended: false }],
  limit: 15,
};

const STOREFRONT: RepoSummary = {
  ...base,
  id: "00000000-0000-4000-8000-0000000000a1",
  full_name: "ada-lovelace/storefront",
  is_private: true,
  scanned_at: "2026-10-01T06:10:00Z",
  health_score: health.score,
  health_grade: health.grade,
  counts: health.counts,
  stats: {
    dependencies: 613,
    direct: 22,
    pinned: 613,
    ecosystems: ["npm"],
    method: "lockfiles",
    manifests: ["package-lock.json"],
    findings: REPORT.reduce((total, entry) => total + entry.findings.length, 0),
  },
};

export const DEMO_REPO_DETAIL: RepoDetail = {
  ...STOREFRONT,
  default_branch: "main",
  badge_token: "00000000-0000-4000-8000-00000000bad6",
  report: REPORT,
  notes: [],
  runtimes: [{ product: "nodejs", cycle: "22", version: "22.11.0", source: ".nvmrc" }],
};

export const DEMO_REPOS: RepoSummary[] = [
  STOREFRONT,
  {
    ...base,
    id: "00000000-0000-4000-8000-0000000000a2",
    full_name: "ada-lovelace/analytical-engine",
    scanned_at: "2026-10-01T06:10:00Z",
    health_score: 94,
    health_grade: "A",
    counts: { urgent: 0, high: 0, medium: 1, low: 0 },
    stats: { dependencies: 768, direct: 33, ecosystems: ["npm"], method: "lockfiles", manifests: ["package-lock.json"] },
  },
  {
    ...base,
    id: "00000000-0000-4000-8000-0000000000a3",
    full_name: "ada-lovelace/notes-on-bernoulli",
    scanned_at: "2026-10-01T06:11:00Z",
    health_score: 100,
    health_grade: "A",
    counts: { urgent: 0, high: 0, medium: 0, low: 0 },
    stats: { dependencies: 74, direct: 33, ecosystems: ["crates.io", "GitHub Actions"], method: "both", manifests: ["Cargo.lock"] },
  },
  {
    ...base,
    id: "00000000-0000-4000-8000-0000000000a4",
    full_name: "gin-gonic/gin",
    installation_id: null,
    scan_status: "pending",
    scanned_at: null,
    health_score: null,
    health_grade: null,
    counts: {},
    stats: {},
  },
  {
    ...base,
    id: "00000000-0000-4000-8000-0000000000a5",
    full_name: "ada-lovelace/difference-engine",
    is_archived: true,
    watching: false,
    scan_status: "pending",
    scanned_at: null,
    health_score: null,
    health_grade: null,
    counts: {},
    stats: {},
  },
];

/**
 * The storefront report as an email, built by the same code that builds the
 * real one. `alert` is the message that goes out on its own for something
 * urgent. `bundled` is a regular issue with Repo Guard leading it.
 */
export function demoGuardIssue(kind: "alert" | "bundled"): Issue {
  let id = 0;
  const pending = REPORT.flatMap((entry) =>
    entry.findings.map((finding) => ({
      id: ++id,
      repoId: STOREFRONT.id,
      key: finding.key,
      urgent: finding.priority === "urgent",
    }))
  );
  const news = buildGuardNews(
    [{ id: STOREFRONT.id, fullName: STOREFRONT.full_name, grade: STOREFRONT.health_grade, score: STOREFRONT.health_score, report: REPORT }],
    pending,
    { urgentOnly: kind === "alert", baseUrl: "https://devlr.example" }
  );
  const section = news.section!;

  if (kind === "alert") {
    return { ...guardCopy(section, true), date: SAMPLE_ISSUE.date, sections: [section], aiEdited: false };
  }
  const copy = guardCopy(section, false);
  return {
    ...SAMPLE_ISSUE,
    subject: copy.subject,
    preheader: `${copy.preheader.split(" Plus ")[0]} Also: ${SAMPLE_ISSUE.subject}`.slice(0, 110),
    sections: [section, ...SAMPLE_ISSUE.sections],
  };
}
