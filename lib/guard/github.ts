import { isIgnoredPath, isManifestPath, type ManifestFile } from "@/lib/guard/lockfiles";
import { isRuntimePath } from "@/lib/guard/runtimes";
import { mapLimit, userAgent } from "@/lib/sources/http";
import type { SpdxDocument } from "@/lib/guard/sbom";
import type { RepoRef } from "@/lib/guard/types";

/**
 * Read-only access to a repository on GitHub.
 *
 * Everything here needs, at most, read access to contents and metadata. For a
 * public repository it works with no credentials at all (60 requests an hour
 * per address), which is what lets a scan be tried before anything is
 * installed. With a GitHub App installation token the limit is 5,000 an hour
 * and private repositories the user chose become readable.
 *
 * Only manifests and lockfiles are ever fetched. No source code is read.
 */

const API = "https://api.github.com";
/** A lockfile bigger than this is not parsed; the SBOM path covers large repos. */
const MAX_FILE_BYTES = 8_000_000;
/** Enough for a sizeable monorepo, and a ceiling on requests for a pathological one. */
const MAX_FILES = 80;

export interface GithubAuth {
  /** An installation token, or a personal token. Omit for public repositories. */
  token?: string;
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GithubError";
  }
}

function headers(auth: GithubAuth, accept = "application/vnd.github+json"): Record<string, string> {
  const token = auth.token ?? process.env.GITHUB_TOKEN;
  return {
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": userAgent(),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function request(path: string, auth: GithubAuth, accept?: string): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    headers: headers(auth, accept),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const minutes = Math.max(1, Math.ceil((reset - Date.now()) / 60_000));
      throw new GithubError(`GitHub rate limit reached. It resets in about ${minutes} minutes.`, response.status);
    }
  }
  return response;
}

const repoPath = ({ owner, repo }: RepoRef) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export interface RepoMeta {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
}

export async function fetchRepoMeta(repo: RepoRef, auth: GithubAuth = {}): Promise<RepoMeta> {
  const response = await request(repoPath(repo), auth);
  if (response.status === 404) {
    throw new GithubError(`${repo.owner}/${repo.repo} was not found, or is private and not shared with Devlr.`, 404);
  }
  if (!response.ok) throw new GithubError(`GitHub answered ${response.status} for ${repo.owner}/${repo.repo}.`, response.status);

  const data = await response.json();
  return {
    id: data.id,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: Boolean(data.private),
    archived: Boolean(data.archived),
    pushedAt: data.pushed_at ?? null,
  };
}

/**
 * The repository's dependency graph as SPDX, or null when there is none.
 *
 * Null is an ordinary outcome, not a failure: the graph is off for many
 * repositories (including, as it turned out, this project's own), and the
 * caller falls back to reading lockfiles.
 */
export async function fetchSbom(repo: RepoRef, auth: GithubAuth = {}): Promise<SpdxDocument | null> {
  const response = await request(`${repoPath(repo)}/dependency-graph/sbom`, auth);
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new GithubError(`GitHub answered ${response.status} for the dependency graph.`, response.status);
  const data = await response.json();
  return (data.sbom ?? null) as SpdxDocument | null;
}

/** Paths of every manifest, lockfile and runtime-pinning file in the tree. */
export async function listRelevantPaths(
  repo: RepoRef,
  ref: string,
  auth: GithubAuth = {}
): Promise<{ manifests: string[]; runtimes: string[]; truncated: boolean }> {
  const response = await request(`${repoPath(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, auth);
  if (!response.ok) throw new GithubError(`GitHub answered ${response.status} listing files.`, response.status);

  const data = (await response.json()) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
  const manifests: string[] = [];
  const runtimes: string[] = [];

  for (const entry of data.tree ?? []) {
    if (entry.type !== "blob" || isIgnoredPath(entry.path) || (entry.size ?? 0) > MAX_FILE_BYTES) continue;
    if (isManifestPath(entry.path)) manifests.push(entry.path);
    // go.mod is both a manifest and (through `toolchain`) a runtime pin.
    if (isRuntimePath(entry.path)) runtimes.push(entry.path);
  }

  // Shallowest first, so the root of a huge monorepo is read before its leaves.
  const byDepth = (a: string, b: string) => a.split("/").length - b.split("/").length || a.localeCompare(b);
  return {
    manifests: manifests.sort(byDepth).slice(0, MAX_FILES),
    runtimes: runtimes.sort(byDepth).slice(0, 20),
    truncated: Boolean(data.truncated) || manifests.length > MAX_FILES,
  };
}

/** A file's text, or null if it does not exist at that ref. */
export async function fetchFile(repo: RepoRef, path: string, ref: string, auth: GithubAuth = {}): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await request(
    `${repoPath(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    auth,
    "application/vnd.github.raw+json"
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubError(`GitHub answered ${response.status} for ${path}.`, response.status);
  return response.text();
}

export async function fetchFiles(
  repo: RepoRef,
  paths: string[],
  ref: string,
  auth: GithubAuth = {}
): Promise<ManifestFile[]> {
  const results = await mapLimit(paths, 6, async (path) => ({ path, content: await fetchFile(repo, path, ref, auth) }));
  const files: ManifestFile[] = [];
  for (const { result, error } of results) {
    if (error) throw new Error(error);
    if (result?.content != null) files.push({ path: result.path, content: result.content });
  }
  return files;
}

/** "owner/repo", a github.com URL, or "owner/repo@ref". */
export function parseRepoRef(input: string): RepoRef | null {
  const clean = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const match = clean.match(/^([\w.-]+)\/([\w.-]+?)(?:@(.+)|\/tree\/(.+))?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], ref: match[3] ?? match[4] };
}
