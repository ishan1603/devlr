import { createAdminClient } from "@/lib/supabase-admin";
import type { AccessibleRepo, GithubIdentity, Installation } from "@/lib/github/app";
import { fetchRepoMeta, GithubError, parseRepoRef } from "@/lib/guard/github";

/**
 * Which repositories a reader watches.
 *
 * Reads in the app go through the reader's own session and row level
 * security. Everything here is a write, and writes go through the service
 * role after the route has established who is asking, so that the limits
 * below hold no matter what the request says.
 */

/**
 * How many repositories one reader can have scanned. Each one costs a daily
 * scan, and the whole service runs on free tiers.
 */
export const MAX_WATCHED_REPOS = Number(process.env.GUARD_MAX_REPOS) || 15;
/** How many repositories from a GitHub account are listed to choose from. */
const MAX_LISTED_REPOS = 300;

export type RepoResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string) => ({ ok: false as const, status, error });

async function watchedCount(userId: string): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("repositories")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("watching", true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Repo Guard has no schedule row until the first repository arrives. Created
 * daily: a new advisory is the kind of thing worth hearing about the next
 * morning, and a day with nothing new sends nothing.
 */
async function ensureSubscription(userId: string) {
  await createAdminClient()
    .from("subscriptions")
    .upsert(
      { user_id: userId, module: "repo_guard", is_active: true, frequency: "daily" },
      { onConflict: "user_id,module", ignoreDuplicates: true }
    );
}

/**
 * Watch a public repository by name. Needs no GitHub connection: anyone can
 * read a public repository's manifests, which is also why a private one is
 * refused here and has to come through the App.
 */
export async function addPublicRepo(userId: string, input: string): Promise<RepoResult<{ id: string; fullName: string }>> {
  const ref = parseRepoRef(input);
  if (!ref) return refuse(400, "That does not look like a repository. Use owner/name or a github.com link.");

  let meta;
  try {
    meta = await fetchRepoMeta(ref);
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) {
      return refuse(404, "GitHub has no public repository by that name. For a private one, connect GitHub.");
    }
    return refuse(502, err instanceof Error ? err.message : "GitHub could not be reached.");
  }
  if (meta.private) return refuse(403, "That repository is private. Connect GitHub to watch it.");

  const supabase = createAdminClient();
  const { data: already } = await supabase
    .from("repositories")
    .select("id, full_name, watching")
    .eq("user_id", userId)
    .eq("github_id", meta.id)
    .maybeSingle();
  if (already?.watching) {
    return { ok: true, value: { id: already.id as string, fullName: already.full_name as string } };
  }

  if ((await watchedCount(userId)) >= MAX_WATCHED_REPOS) {
    return refuse(409, `You are watching ${MAX_WATCHED_REPOS} repositories, which is the limit. Stop watching one first.`);
  }

  const { data, error } = await supabase
    .from("repositories")
    .upsert(
      {
        user_id: userId,
        github_id: meta.id,
        full_name: meta.fullName,
        default_branch: meta.defaultBranch,
        is_private: false,
        is_archived: meta.archived,
        watching: true,
        needs_read: true,
      },
      { onConflict: "user_id,github_id" }
    )
    .select("id, full_name")
    .single();
  if (error) throw new Error(`Could not add the repository: ${error.message}`);

  await ensureSubscription(userId);
  return { ok: true, value: { id: data.id as string, fullName: data.full_name as string } };
}

/** Start or stop watching a repository the reader already has listed. */
export async function setWatching(userId: string, repoId: string, watching: boolean): Promise<RepoResult<{ id: string }>> {
  const supabase = createAdminClient();
  const { data: repo } = await supabase
    .from("repositories")
    .select("id, watching")
    .eq("id", repoId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!repo) return refuse(404, "Repository not found.");
  if (repo.watching === watching) return { ok: true, value: { id: repoId } };

  if (watching && (await watchedCount(userId)) >= MAX_WATCHED_REPOS) {
    return refuse(409, `You are watching ${MAX_WATCHED_REPOS} repositories, which is the limit. Stop watching one first.`);
  }

  const { error } = await supabase
    .from("repositories")
    // Watching again after a gap means the stored dependency list may be stale.
    .update(watching ? { watching: true, needs_read: true } : { watching: false })
    .eq("id", repoId)
    .eq("user_id", userId);
  if (error) throw new Error(`Could not update the repository: ${error.message}`);

  if (watching) await ensureSubscription(userId);
  return { ok: true, value: { id: repoId } };
}

/**
 * Remove a repository and everything stored about it.
 *
 * Only for one added by name. A repository that came through the App is
 * managed on GitHub: removing it here would just have it reappear on the next
 * sync, so those can be unwatched instead.
 */
export async function removeRepo(userId: string, repoId: string): Promise<RepoResult<{ id: string }>> {
  const supabase = createAdminClient();
  const { data: repo } = await supabase
    .from("repositories")
    .select("id, installation_id")
    .eq("id", repoId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!repo) return refuse(404, "Repository not found.");
  if (repo.installation_id !== null) {
    return refuse(409, "This repository comes from your GitHub connection. Stop watching it, or remove it from the Devlr app on GitHub.");
  }

  const { error } = await supabase.from("repositories").delete().eq("id", repoId).eq("user_id", userId);
  if (error) throw new Error(`Could not remove the repository: ${error.message}`);
  return { ok: true, value: { id: repoId } };
}

export interface LinkResult {
  installations: number;
  /** Repositories now listed for this reader. */
  repositories: number;
  /** Ids of repositories that should be scanned now. */
  toScan: string[];
}

/**
 * Record the installations a reader has proved they can reach, and the
 * repositories in each that they can read.
 *
 * `installations` and `reposByInstallation` must come from GitHub, asked with
 * the reader's own token. Nothing here re-checks that, and nothing here trusts
 * the request: the route is what stands between a URL parameter and this.
 *
 * New repositories are watched automatically, most recently pushed first,
 * until the limit is reached. The rest are listed, unwatched, for the reader
 * to switch on. Repositories that are no longer in the list are removed, with
 * what was stored about them.
 */
export async function linkInstallations(
  userId: string,
  identity: GithubIdentity,
  installations: Installation[],
  reposByInstallation: Map<number, AccessibleRepo[]>
): Promise<LinkResult> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const toScan: string[] = [];
  let listed = 0;

  for (const installation of installations) {
    const { error: linkError } = await supabase.from("github_installations").upsert(
      {
        user_id: userId,
        installation_id: installation.id,
        account_login: installation.accountLogin,
        account_type: installation.accountType,
        github_login: identity.login,
        github_user_id: identity.id,
        suspended_at: installation.suspended ? now : null,
        verified_at: now,
      },
      { onConflict: "user_id,installation_id" }
    );
    if (linkError) throw new Error(`Could not link the installation: ${linkError.message}`);

    const accessible = (reposByInstallation.get(installation.id) ?? [])
      .slice()
      .sort((a, b) => Date.parse(b.pushedAt ?? "0") - Date.parse(a.pushedAt ?? "0"))
      .slice(0, MAX_LISTED_REPOS);

    const { data: existing, error: existingError } = await supabase
      .from("repositories")
      .select("id, github_id, installation_id")
      .eq("user_id", userId);
    if (existingError) throw new Error(existingError.message);
    const byGithubId = new Map((existing ?? []).map((r) => [Number(r.github_id), r]));

    // Gone from the installation, or no longer readable by this person.
    const stillThere = new Set(accessible.map((r) => r.id));
    const gone = (existing ?? [])
      .filter((r) => Number(r.installation_id) === installation.id && !stillThere.has(Number(r.github_id)))
      .map((r) => r.id as string);
    if (gone.length > 0) {
      const { error } = await supabase.from("repositories").delete().in("id", gone);
      if (error) throw new Error(error.message);
    }

    let room = Math.max(0, MAX_WATCHED_REPOS - (await watchedCount(userId)));
    for (const repo of accessible) {
      listed++;
      const known = byGithubId.get(repo.id);

      if (known) {
        // Keep the reader's own choice about watching. Refresh the rest. A repo
        // first added by name is adopted by the installation, which can read it
        // even if it later goes private.
        const { error } = await supabase
          .from("repositories")
          .update({
            installation_id: installation.id,
            full_name: repo.fullName,
            default_branch: repo.defaultBranch,
            is_private: repo.private,
            is_archived: repo.archived,
          })
          .eq("id", known.id);
        if (error) throw new Error(error.message);
        continue;
      }

      const watch = room > 0 && !repo.archived;
      const { data: created, error } = await supabase
        .from("repositories")
        .insert({
          user_id: userId,
          installation_id: installation.id,
          github_id: repo.id,
          full_name: repo.fullName,
          default_branch: repo.defaultBranch,
          is_private: repo.private,
          is_archived: repo.archived,
          watching: watch,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Could not add ${repo.fullName}: ${error.message}`);
      if (watch) {
        room--;
        toScan.push(created.id as string);
      }
    }
  }

  if (toScan.length > 0) await ensureSubscription(userId);
  return { installations: installations.length, repositories: listed, toScan };
}

/** Forget an installation for one reader, with its repositories and their findings. */
export async function unlinkInstallation(userId: string, installationId: number): Promise<void> {
  const { error } = await createAdminClient()
    .from("github_installations")
    .delete()
    .eq("user_id", userId)
    .eq("installation_id", installationId);
  if (error) throw new Error(`Could not disconnect: ${error.message}`);
}
