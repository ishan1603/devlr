import type { Me, ProfileUpdateInput } from "@/lib/profile";
import type { Issue } from "@/lib/delivery/issue";

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
