import type { Me, ProfileUpdateInput } from "@/lib/profile";
import type { Issue } from "@/lib/delivery/issue";
import type { GuardAccount, RepoSummary } from "@/lib/guard/view";

/**
 * Browser-side calls to this app's own API. One place, so every caller gets
 * the same error handling: a thrown Error whose message is safe to show.
 */

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export function saveMe(patch: ProfileUpdateInput): Promise<Me> {
  return request<Me>("/api/me", { method: "PUT", body: JSON.stringify(patch) });
}

export function fetchPreview(): Promise<{ issue: Issue | null }> {
  return request<{ issue: Issue | null }>("/api/preview");
}

export function sendNow(): Promise<{ queued: boolean }> {
  return request<{ queued: boolean }>("/api/send-now", { method: "POST" });
}

export function deleteAccount(): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>("/api/account", { method: "DELETE" });
}

/* ------------------------------------------------------------ Repo Guard -- */

export function listRepos(): Promise<{ repos: RepoSummary[]; account: GuardAccount }> {
  return request("/api/repos");
}

/** Watch a public repository by "owner/name" or a github.com link. */
export function addRepo(repo: string): Promise<{ repo: { id: string; fullName: string } }> {
  return request("/api/repos", { method: "POST", body: JSON.stringify({ repo }) });
}

export function setRepoWatching(id: string, watching: boolean): Promise<{ ok: boolean }> {
  return request(`/api/repos/${id}`, { method: "PATCH", body: JSON.stringify({ watching }) });
}

export function removeRepo(id: string): Promise<{ ok: boolean }> {
  return request(`/api/repos/${id}`, { method: "DELETE" });
}

export function scanRepo(id: string): Promise<{ queued: boolean }> {
  return request(`/api/repos/${id}/scan`, { method: "POST" });
}

export function disconnectGithub(installationId: number): Promise<{ ok: boolean }> {
  return request(`/api/github/installations/${installationId}`, { method: "DELETE" });
}
