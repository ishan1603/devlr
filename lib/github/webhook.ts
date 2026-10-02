import { isManifestPath } from "@/lib/guard/lockfiles";
import { isRuntimePath } from "@/lib/guard/runtimes";

/**
 * Reading GitHub's webhook payloads. Kept apart from the route so the one
 * decision in here, whether a push is worth a scan, can be tested.
 */

/** GitHub lists at most this many commits in a push. More than that, and the list is incomplete. */
const MAX_LISTED_COMMITS = 20;

export interface PushPayload {
  ref?: string;
  forced?: boolean;
  repository?: { id: number; default_branch?: string };
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
}

/** Is this a push to the repository's default branch? Tags and feature branches are not scanned. */
export function isDefaultBranchPush(payload: PushPayload): boolean {
  const branch = payload.repository?.default_branch;
  return Boolean(branch) && payload.ref === `refs/heads/${branch}`;
}

/** Did this push change anything a scan reads? */
export function touchesDependencies(payload: PushPayload): boolean {
  const commits = payload.commits ?? [];
  // A force push, or a push too big to list, could contain anything.
  if (payload.forced || commits.length >= MAX_LISTED_COMMITS) return true;
  return commits.some((commit) =>
    [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])].some(
      (path) => isManifestPath(path) || isRuntimePath(path)
    )
  );
}
