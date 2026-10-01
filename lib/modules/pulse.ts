import { createAdminClient, selectAll } from "@/lib/supabase-admin";
import { cleanProse } from "@/lib/ai/style";
import { loadSeen } from "@/lib/delivery/ledger";
import { fetchJSON } from "@/lib/sources/http";
import { githubLanguagesFor } from "@/lib/topics/catalog";
import type { ModuleResult, PulseRepo } from "@/lib/delivery/issue";

/**
 * Dev Pulse: repositories that appeared recently and took off.
 *
 * GitHub has no trending API, and scraping the trending page is against their
 * terms. The search API answers a close question honestly: of the repositories
 * created in the last few weeks, which have the most stars. Fetched once per
 * language and shared by every reader of that language.
 */

/** The catch-all bucket for readers with no language in their stack. */
export const ALL_LANGUAGES = "all";

const CREATED_WITHIN_DAYS = 21;
const REPOS_PER_LANGUAGE = 8;
const REPOS_PER_ISSUE = 5;

interface GithubRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  topics?: string[];
  created_at: string;
  fork: boolean;
  archived: boolean;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  // Optional. Unauthenticated search allows 10 requests a minute, which is
  // enough when the caller paces itself; a token raises that to 30.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

/** Monday of the current week (UTC), as the key repos are stored under. */
export function weekOf(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Languages worth fetching: those in any set-up reader's stack, plus "all".
 *
 * It reads every profile rather than only Dev Pulse subscribers. Joining the
 * two would mean passing a list of user ids in a URL, which stops fitting
 * after a few hundred readers, and the cost of being generous here is at most
 * a dozen extra search requests a day.
 */
export async function activePulseLanguages(): Promise<string[]> {
  const supabase = createAdminClient();
  const languages = new Set<string>([ALL_LANGUAGES]);

  const profiles = await selectAll((from, to) =>
    supabase
      .from("profiles")
      .select("stack")
      .not("onboarded_at", "is", null)
      .order("user_id")
      .range(from, to)
  );

  for (const profile of profiles) {
    for (const language of githubLanguagesFor((profile.stack as string[]) ?? [])) languages.add(language);
  }
  return [...languages].sort();
}

/** Fetch and store this week's repos for one language. One search request. */
export async function refreshPulseLanguage(language: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - CREATED_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const qualifiers = [`created:>${since}`, language === ALL_LANGUAGES ? "stars:>150" : `language:"${language}" stars:>40`];
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(qualifiers.join(" "))}` +
    `&sort=stars&order=desc&per_page=${REPOS_PER_LANGUAGE + 8}`;

  const data = await fetchJSON<{ items: GithubRepo[] }>(url, { headers: githubHeaders() });

  const repos = (data.items ?? [])
    // A brand-new repo with thousands of stars and no description is usually
    // a star-farming account, and tells a reader nothing either way.
    .filter(
      (r) =>
        !r.fork &&
        !r.archived &&
        (r.description ?? "").trim().length >= 12 &&
        isMostlyLatin(r.description ?? "")
    )
    .slice(0, REPOS_PER_LANGUAGE);
  if (repos.length === 0) return 0;

  const supabase = createAdminClient();
  const { error } = await supabase.from("pulse_repos").upsert(
    repos.map((repo, index) => ({
      week: weekOf(now),
      language,
      full_name: repo.full_name,
      url: repo.html_url,
      description: cleanProse(repo.description ?? "").slice(0, 280),
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      topics: (repo.topics ?? []).slice(0, 8),
      repo_created_at: repo.created_at,
      rank: index + 1,
      fetched_at: now.toISOString(),
    })),
    { onConflict: "week,language,full_name" }
  );
  if (error) throw new Error(`Failed to store pulse repos: ${error.message}`);
  return repos.length;
}

/**
 * Is this description readable by an English-language audience? Search results
 * are global, and a description nobody on the list can read is a wasted slot.
 */
export function isMostlyLatin(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return false;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, "").length;
  return latin / letters.length >= 0.8;
}

export function formatStars(stars: number): string {
  return stars >= 1000 ? `${(stars / 1000).toFixed(stars >= 10_000 ? 0 : 1)}k` : String(stars);
}

/**
 * Pick repos for one reader: the best across their languages that they have
 * not been shown before, interleaved so one language cannot take every slot.
 */
export async function assemblePulse(profile: { user_id: string; stack: string[] }): Promise<ModuleResult> {
  const supabase = createAdminClient();
  const languages = githubLanguagesFor(profile.stack);
  const wanted = languages.length > 0 ? languages : [ALL_LANGUAGES];

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [{ data: rows, error }, seen] = await Promise.all([
    supabase
      .from("pulse_repos")
      .select("language, full_name, url, description, stars, rank, week")
      .in("language", wanted)
      .gte("week", since)
      .order("week", { ascending: false })
      .order("rank", { ascending: true }),
    loadSeen(profile.user_id, "repo", 180),
  ]);
  if (error) throw new Error(`Failed to load pulse repos: ${error.message}`);

  const byLanguage = new Map<string, PulseRepo[]>();
  const taken = new Set<string>();
  for (const row of rows ?? []) {
    const name = row.full_name as string;
    if (seen.refs.has(name) || taken.has(name)) continue;
    taken.add(name);
    const list = byLanguage.get(row.language as string) ?? [];
    list.push({
      fullName: name,
      url: row.url as string,
      description: (row.description as string) ?? "",
      language: row.language === ALL_LANGUAGES ? "" : (row.language as string),
      stars: row.stars as number,
    });
    byLanguage.set(row.language as string, list);
  }

  // Round-robin across languages, each already in rank order.
  const repos: PulseRepo[] = [];
  const queues = [...byLanguage.values()];
  while (repos.length < REPOS_PER_ISSUE && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) repos.push(next);
      if (repos.length === REPOS_PER_ISSUE) break;
    }
  }
  if (repos.length === 0) return { sections: [], seen: [] };

  return {
    sections: [
      { type: "repos", module: "dev_pulse", label: "dev pulse", title: "New and climbing on GitHub", repos },
    ],
    seen: repos.map((r) => ({ module: "dev_pulse" as const, itemType: "repo", ref: r.fullName, canonicalUrl: r.url })),
  };
}
