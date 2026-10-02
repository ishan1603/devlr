import { createAdminClient } from "@/lib/supabase-admin";
import { InstallationGone, canStillRead, installationToken } from "@/lib/github/app";
import { fetchRepoMeta, GithubError } from "@/lib/guard/github";
import { fetchKev, type Deprecation } from "@/lib/guard/intel";
import { packInventory, unpackInventory } from "@/lib/guard/pack";
import { groupKeyOf } from "@/lib/guard/rollup";
import { analyzeInventory, readRepository, type ScanCache } from "@/lib/guard/scan";
import type { DetectedRuntime } from "@/lib/guard/runtimes";
import type { Advisory, Inventory } from "@/lib/guard/types";

/**
 * Repo Guard and the database.
 *
 * lib/guard/scan.ts knows how to check a dependency list and nothing about
 * where anything is kept. This file is the other half: it loads a watched
 * repository, decides whether its files need reading again, runs the scan with
 * the shared caches behind it, and stores the outcome in one transaction.
 *
 * Server only. Everything here uses the service role.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** Rows per `in (...)` filter, to keep the request URL a sane length. */
const CHUNK = 100;
/** CISA updates its list on working days, so a copy from this morning is current. */
const KEV_TTL_MS = 20 * 3_600_000;
/** "Not deprecated" is re-asked weekly: maintainers deprecate old versions after the fact. */
const NOT_DEPRECATED_TTL_MS = 7 * 86_400_000;
const DEPRECATED_TTL_MS = 30 * 86_400_000;
/** A report longer than this is a repo with bigger problems than a long list. */
const MAX_REPORT_ENTRIES = 250;

const chunks = <T>(items: T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

// ---------------------------------------------------------------------------
// Shared caches
// ---------------------------------------------------------------------------

/**
 * CISA's exploited list, from the cache if it is recent and from CISA if not.
 * Returns undefined when neither works, which the scan handles by trying the
 * source itself and carrying on without it if that fails too.
 */
export async function loadKev(supabase: Admin, now: Date = new Date()): Promise<Set<string> | undefined> {
  const { data } = await supabase.from("guard_cache").select("data, fetched_at").eq("key", "kev").maybeSingle();
  if (data && now.getTime() - Date.parse(data.fetched_at as string) < KEV_TTL_MS && Array.isArray(data.data)) {
    return new Set(data.data as string[]);
  }

  try {
    const fresh = await fetchKev();
    await supabase
      .from("guard_cache")
      .upsert({ key: "kev", data: [...fresh], fetched_at: now.toISOString() }, { onConflict: "key" });
    return fresh;
  } catch (err) {
    console.warn("[guard] could not refresh the KEV list:", err);
    // A stale list still beats none: entries are almost never removed from it.
    return data && Array.isArray(data.data) ? new Set(data.data as string[]) : undefined;
  }
}

export function scanCache(supabase: Admin, now: Date = new Date()): ScanCache {
  return {
    async advisories(ids) {
      const found = new Map<string, Advisory>();
      for (const group of chunks(ids)) {
        const { data, error } = await supabase.from("guard_advisories").select("id, data").in("id", group);
        if (error) throw new Error(error.message);
        for (const row of data ?? []) found.set(row.id as string, row.data as Advisory);
      }
      return found;
    },

    async deprecations(keys) {
      const found = new Map<string, Deprecation | null>();
      for (const group of chunks(keys)) {
        const { data, error } = await supabase
          .from("guard_package_status")
          .select("key, deprecated, reason, checked_at")
          .in("key", group);
        if (error) throw new Error(error.message);
        for (const row of data ?? []) {
          const age = now.getTime() - Date.parse(row.checked_at as string);
          if (age > (row.deprecated ? DEPRECATED_TTL_MS : NOT_DEPRECATED_TTL_MS)) continue;
          found.set(row.key as string, row.deprecated ? { reason: (row.reason as string) ?? "" } : null);
        }
      }
      return found;
    },
  };
}

async function saveAdvisories(supabase: Admin, advisories: Advisory[]) {
  // The same advisory can be fetched twice in one scan (once to match, once
  // while checking an upgrade target), and an upsert rejects duplicate keys.
  const unique = [...new Map(advisories.map((a) => [a.id, a])).values()];
  for (const group of chunks(unique)) {
    const { error } = await supabase.from("guard_advisories").upsert(
      group.map((a) => ({ id: a.id, modified: a.modified, data: a, fetched_at: new Date().toISOString() })),
      { onConflict: "id" }
    );
    if (error) throw new Error(error.message);
  }
}

async function saveDeprecations(supabase: Admin, learned: Map<string, Deprecation | null>) {
  const rows = [...learned].map(([key, notice]) => ({
    key,
    deprecated: notice !== null,
    reason: notice?.reason ?? null,
    checked_at: new Date().toISOString(),
  }));
  for (const group of chunks(rows)) {
    const { error } = await supabase.from("guard_package_status").upsert(group, { onConflict: "key" });
    if (error) throw new Error(error.message);
  }
}

// ---------------------------------------------------------------------------
// Scanning a watched repository
// ---------------------------------------------------------------------------

export type ScanOutcome =
  | {
      status: "scanned";
      repoId: string;
      userId: string;
      /** Whether the files were read from GitHub, or the stored list was re-checked. */
      read: boolean;
      added: number;
      resolved: number;
      /** Findings the reader has not been told about yet. */
      pending: number;
      /** Of those, how many should not wait for the next regular issue. */
      pendingUrgent: number;
      grade: string;
    }
  | { status: "skipped"; repoId: string; reason: string }
  | { status: "failed"; repoId: string; error: string };

interface StoredRepo {
  id: string;
  user_id: string;
  installation_id: number | null;
  github_id: number;
  full_name: string;
  watching: boolean;
  needs_read: boolean;
  pushed_at: string | null;
  inventory: unknown;
  runtimes: DetectedRuntime[] | null;
}

async function fail(supabase: Admin, repoId: string, message: string): Promise<ScanOutcome> {
  await supabase
    .from("repositories")
    .update({ scan_status: "failed", scan_error: message.slice(0, 500), scanned_at: new Date().toISOString() })
    .eq("id", repoId);
  return { status: "failed", repoId, error: message };
}

/** Same instant, whatever the spelling. Postgres and GitHub format timestamps differently. */
const sameInstant = (a: string | null, b: string | null) =>
  a !== null && b !== null && Date.parse(a) === Date.parse(b);

/**
 * Scan one watched repository and store the result.
 *
 * The repository's files are only read from GitHub when something says they
 * may have changed: it is new, a push touched a manifest, GitHub reports a
 * newer push than the one stored, or `force` is set. Otherwise the dependency
 * list kept from last time is checked against today's advisories, which costs
 * GitHub one request instead of a dozen.
 *
 * Never throws for an ordinary failure. It records it on the repository, so
 * the reader sees why their repo was not scanned, and returns.
 */
export async function scanStoredRepo(repoId: string, options: { force?: boolean } = {}): Promise<ScanOutcome> {
  const supabase = createAdminClient();

  const { data: repo, error } = await supabase
    .from("repositories")
    .select("id, user_id, installation_id, github_id, full_name, watching, needs_read, pushed_at, inventory, runtimes")
    .eq("id", repoId)
    .maybeSingle<StoredRepo>();
  if (error) throw new Error(`Could not load repository ${repoId}: ${error.message}`);
  if (!repo) return { status: "skipped", repoId, reason: "no longer exists" };
  if (!repo.watching) return { status: "skipped", repoId, reason: "not being watched" };

  try {
    // -- Access ---------------------------------------------------------------
    let token: string | undefined;
    if (repo.installation_id !== null) {
      const { data: link } = await supabase
        .from("github_installations")
        .select("github_login, suspended_at")
        .eq("user_id", repo.user_id)
        .eq("installation_id", repo.installation_id)
        .maybeSingle();
      if (!link) return { status: "skipped", repoId, reason: "installation no longer linked" };
      if (link.suspended_at) return fail(supabase, repoId, "The Devlr app is suspended on this GitHub account.");

      token = await installationToken(repo.installation_id);

      // Someone who has lost access to the repository on GitHub loses it here
      // too, including what was already stored about it.
      const allowed = await canStillRead(token, repo.full_name, link.github_login as string);
      if (allowed === false) {
        await supabase.from("repositories").delete().eq("id", repoId);
        return { status: "skipped", repoId, reason: "access to the repository was removed on GitHub" };
      }
    }

    const [owner, name] = repo.full_name.split("/");
    const auth = token ? { token } : {};
    const meta = await fetchRepoMeta({ owner, repo: name }, auth);

    // A renamed repo answers under its old name. A different repo answering
    // under that name means the original is gone and the name was reused.
    if (meta.id !== repo.github_id) {
      return fail(supabase, repoId, `${repo.full_name} now points at a different repository.`);
    }
    if (meta.private && repo.installation_id === null) {
      return fail(supabase, repoId, "This repository is now private. Connect GitHub to keep watching it.");
    }

    // -- Read, or reuse ---------------------------------------------------------
    const stored = unpackInventory(repo.inventory);
    const mustRead =
      options.force || repo.needs_read || stored === null || !sameInstant(meta.pushedAt, repo.pushed_at);

    let inventory: Inventory;
    let runtimes: DetectedRuntime[];
    const warnings: string[] = [];
    if (mustRead) {
      const [newOwner, newName] = meta.fullName.split("/");
      const read = await readRepository({ owner: newOwner, repo: newName }, meta.defaultBranch, auth);
      ({ inventory, runtimes } = read);
      warnings.push(...read.warnings);
    } else {
      inventory = stored!;
      runtimes = repo.runtimes ?? [];
    }

    // -- Check ------------------------------------------------------------------
    const analysis = await analyzeInventory(inventory, runtimes, {
      kev: await loadKev(supabase),
      cache: scanCache(supabase),
    });
    warnings.push(...analysis.warnings);

    // Losing a cache write costs a refetch next time. It must not cost the scan.
    const saved = await Promise.allSettled([
      saveAdvisories(supabase, analysis.advisories),
      saveDeprecations(supabase, analysis.deprecations),
    ]);
    for (const result of saved) {
      if (result.status === "rejected") console.warn("[guard] cache write failed:", result.reason);
    }

    // -- Store ------------------------------------------------------------------
    const { data: applied, error: applyError } = await supabase.rpc("guard_apply_scan", {
      p_repo_id: repoId,
      p_findings: analysis.findings.map((f) => ({
        key: f.key,
        group_key: groupKeyOf(f),
        kind: f.kind,
        priority: f.priority,
      })),
      p_state: {
        scanned_ref: meta.defaultBranch,
        pushed_at: meta.pushedAt,
        full_name: meta.fullName,
        default_branch: meta.defaultBranch,
        is_private: meta.private,
        is_archived: meta.archived,
        health_score: analysis.health.score,
        health_grade: analysis.health.grade,
        counts: analysis.health.counts,
        stats: { ...analysis.stats, method: inventory.method, manifests: inventory.manifests, findings: analysis.findings.length },
        report: analysis.packages.slice(0, MAX_REPORT_ENTRIES),
        notes: [...inventory.notes, ...warnings],
        ...(mustRead ? { inventory: packInventory(inventory), runtimes } : {}),
      },
    });
    if (applyError) throw new Error(`Could not store the scan: ${applyError.message}`);

    const result = applied as { added: number; resolved: number; pending: number; pending_urgent: number };
    return {
      status: "scanned",
      repoId,
      userId: repo.user_id,
      read: mustRead,
      added: result.added,
      resolved: result.resolved,
      pending: result.pending,
      pendingUrgent: result.pending_urgent,
      grade: analysis.health.grade,
    };
  } catch (err) {
    if (err instanceof InstallationGone) {
      await supabase
        .from("github_installations")
        .update({ suspended_at: new Date().toISOString() })
        .eq("installation_id", err.installationId)
        .is("suspended_at", null);
      return fail(supabase, repoId, "Devlr no longer has access to this GitHub account. Reconnect it to resume scans.");
    }
    if (err instanceof GithubError && err.status === 404) {
      return fail(supabase, repoId, "GitHub could not find this repository. It may have been deleted or made private.");
    }
    return fail(supabase, repoId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Repositories due a scan: never scanned, flagged by a push, or last scanned
 * most of a day ago. Oldest first, so a backlog clears in order.
 *
 * A repo whose last scan failed waits out the full interval before it is
 * tried again, even if a push flagged it. Something that is failing because
 * the repository was deleted would otherwise be retried on every sweep.
 */
export async function dueRepositories(limit: number, now: Date = new Date()): Promise<string[]> {
  const supabase = createAdminClient();
  const cutoff = new Date(now.getTime() - 20 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("repositories")
    .select("id")
    .eq("watching", true)
    .or(`scanned_at.is.null,scanned_at.lt.${cutoff},and(needs_read.eq.true,scan_status.neq.failed)`)
    .order("scanned_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`Could not list repositories due a scan: ${error.message}`);
  return (data ?? []).map((row) => row.id as string);
}
