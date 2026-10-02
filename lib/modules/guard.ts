import { createAdminClient } from "@/lib/supabase-admin";
import { appUrl } from "@/lib/delivery/tokens";
import { buildGuardNews, type GuardNews, type GuardRepo, type PendingFinding } from "@/lib/guard/news";
import type { PackageReport } from "@/lib/guard/rollup";
import type { ModuleResult } from "@/lib/delivery/issue";

/**
 * Repo Guard, as a module of an issue.
 *
 * The decisions are in lib/guard/news.ts. This is the part that reads what
 * the database knows about a reader (their watched repositories, and the
 * findings they have not been told about) and writes back that they now have.
 */

async function loadGuardState(userId: string): Promise<{ repos: GuardRepo[]; pending: PendingFinding[] }> {
  const supabase = createAdminClient();

  const { data: findings, error } = await supabase
    .from("repo_findings")
    .select("id, repo_id, key, priority, notified_at, notified_priority")
    .eq("user_id", userId)
    .eq("status", "open")
    // Unannounced, or announced before it became urgent.
    .or("notified_at.is.null,and(priority.eq.urgent,notified_priority.neq.urgent)")
    .order("id")
    .limit(1000);
  if (error) throw new Error(`Failed to load Repo Guard findings: ${error.message}`);
  if (!findings || findings.length === 0) return { repos: [], pending: [] };

  const repoIds = [...new Set(findings.map((f) => f.repo_id as string))];
  const { data: repos, error: repoError } = await supabase
    .from("repositories")
    .select("id, full_name, health_grade, health_score, report")
    .in("id", repoIds)
    .eq("watching", true);
  if (repoError) throw new Error(`Failed to load repositories: ${repoError.message}`);

  return {
    repos: (repos ?? []).map((r) => ({
      id: r.id as string,
      fullName: r.full_name as string,
      grade: (r.health_grade as string) ?? null,
      score: (r.health_score as number) ?? null,
      report: Array.isArray(r.report) ? (r.report as PackageReport[]) : [],
    })),
    pending: findings.map((f) => ({
      id: Number(f.id),
      repoId: f.repo_id as string,
      key: f.key as string,
      urgent: f.priority === "urgent" && f.notified_priority !== "urgent",
    })),
  };
}

export async function loadGuardNews(userId: string, options: { urgentOnly?: boolean } = {}): Promise<GuardNews> {
  const { repos, pending } = await loadGuardState(userId);
  return buildGuardNews(repos, pending, { urgentOnly: options.urgentOnly, baseUrl: appUrl() });
}

/** Record that these findings reached the reader. Called only after a send succeeded. */
export async function markGuardNotified(findingIds: number[]): Promise<void> {
  if (findingIds.length === 0) return;
  const { error } = await createAdminClient().rpc("guard_mark_notified", { p_ids: findingIds });
  if (error) throw new Error(`Failed to record Repo Guard notifications: ${error.message}`);
}

export async function assembleGuard(profile: { user_id: string }): Promise<ModuleResult> {
  const news = await loadGuardNews(profile.user_id);
  if (!news.section) {
    // Unannounced findings that no report shows any more can never be sent.
    // Settling them here is what stops the scheduler coming back for them.
    await markGuardNotified(news.findingIds);
    return { sections: [], seen: [] };
  }

  return {
    sections: [news.section],
    seen: news.refs.map((ref) => ({ module: "repo_guard" as const, itemType: "guard", ref })),
    notified: news.findingIds,
  };
}
