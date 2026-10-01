import { cvss3BaseScore, severityFromLabel, severityFromScore } from "@/lib/guard/cvss";
import { packageKey } from "@/lib/guard/purl";
import { userAgent } from "@/lib/sources/http";
import type { Advisory, Dependency, Ecosystem } from "@/lib/guard/types";

/**
 * OSV.dev: the one place vulnerability matching happens.
 *
 * OSV aggregates the GitHub Advisory Database, PyPA, RustSec, the Go
 * vulnerability database, OpenSSF's malicious-packages list and more, and it
 * evaluates each ecosystem's version rules on its side. We send exact
 * (ecosystem, name, version) triples and get back the ids of advisories that
 * apply. No range logic of our own is involved in deciding what is vulnerable,
 * which is the point: that logic is where homemade scanners go wrong.
 *
 * Free, no key, no documented rate limit beyond reasonable use.
 */

const API = "https://api.osv.dev/v1";
/** The API accepts up to 1,000 queries in one batch. */
const BATCH_SIZE = 1000;

async function osvFetch(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "user-agent": userAgent(), ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OSV answered ${response.status} for ${path}`);
  return response.json();
}

/** Identity of a dependency within one scan. */
export function dependencyKey(d: Pick<Dependency, "ecosystem" | "name" | "version">): string {
  return `${packageKey(d.ecosystem, d.name)}@${d.version}`;
}

export interface Matches {
  /** dependencyKey -> advisory ids. A clean dependency has no entry. */
  byDependency: Map<string, string[]>;
  /**
   * Advisory id -> when OSV last changed it. A copy fetched earlier with the
   * same timestamp is still current and does not need fetching again.
   */
  modified: Map<string, string>;
}

/**
 * Which advisories apply to which dependencies.
 *
 * Only pinned versions are sent: a range has no single answer.
 */
export async function queryVulnerabilities(dependencies: Dependency[]): Promise<Matches> {
  const pinned = dependencies.filter((d) => d.pinned);
  const found = new Map<string, string[]>();
  const modified = new Map<string, string>();

  for (let i = 0; i < pinned.length; i += BATCH_SIZE) {
    const batch = pinned.slice(i, i + BATCH_SIZE);
    let pending = batch.map((d, index) => ({ index, token: undefined as string | undefined }));

    // A query with more results than fit comes back with a page token. Those,
    // and only those, are asked again until they run dry.
    while (pending.length > 0) {
      const body = {
        queries: pending.map(({ index, token }) => ({
          package: { ecosystem: batch[index].ecosystem, name: batch[index].name },
          version: batch[index].version,
          ...(token ? { page_token: token } : {}),
        })),
      };
      const data = await osvFetch("/querybatch", { method: "POST", body: JSON.stringify(body) });
      const results: { vulns?: { id: string; modified?: string }[]; next_page_token?: string }[] = data.results ?? [];

      const next: typeof pending = [];
      results.forEach((result, position) => {
        const { index } = pending[position];
        const ids = (result.vulns ?? []).map((v) => v.id);
        for (const v of result.vulns ?? []) if (v.modified) modified.set(v.id, v.modified);
        if (ids.length > 0) {
          const key = dependencyKey(batch[index]);
          found.set(key, [...new Set([...(found.get(key) ?? []), ...ids])]);
        }
        if (result.next_page_token) next.push({ index, token: result.next_page_token });
      });
      pending = next;
    }
  }

  return { byDependency: found, modified };
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = clean.match(/^.{20,240}?[.!?](?=\s|$)/);
  return (match ? match[0] : clean.slice(0, 200)).trim();
}

/** Turn an OSV record into the shape the rest of Repo Guard uses. */
export function normalizeAdvisory(record: any): Advisory {
  const vector: string | undefined = (record.severity ?? []).find((s: any) => s.type === "CVSS_V3")?.score;
  const computed = vector ? cvss3BaseScore(vector) : null;

  // The advisory database's own label is preferred. It exists for records that
  // only publish a CVSS v4 vector, which is not computed here.
  const labelled = severityFromLabel(record.database_specific?.severity);
  const severity = labelled !== "unknown" ? labelled : severityFromScore(computed);

  // Databases increasingly rate with CVSS v4 and keep an older v3 vector
  // alongside. When the v3 number lands in a different band from the label,
  // printing both ("high, CVSS 5.3") reads as a mistake. The label is the
  // reviewed judgement, so the number is dropped rather than shown beside it.
  const cvss = computed !== null && severityFromScore(computed) === severity ? computed : null;

  const cwes: string[] = record.database_specific?.cwe_ids ?? [];
  const id = String(record.id);
  // CWE-506 is "embedded malicious code": the package is the attack.
  const malicious = id.startsWith("MAL-") || cwes.includes("CWE-506");

  const fixes: Record<string, string[]> = {};
  const imports: Record<string, string[]> = {};
  for (const affected of record.affected ?? []) {
    const ecosystem = String(affected.package?.ecosystem ?? "").split(":")[0] as Ecosystem;
    const name = affected.package?.name;
    if (!ecosystem || !name) continue;
    const key = packageKey(ecosystem, name);

    // Go records list the packages inside the module that carry the bug.
    const paths: string[] = (affected.ecosystem_specific?.imports ?? [])
      .map((entry: any) => String(entry?.path ?? ""))
      .filter((path: string) => path && path !== name);
    if (paths.length > 0) imports[key] = [...new Set([...(imports[key] ?? []), ...paths])];
    for (const range of affected.ranges ?? []) {
      // GIT ranges name commits, which are not versions anyone can install.
      if (range.type === "GIT") continue;
      for (const event of range.events ?? []) {
        if (event.fixed) fixes[key] = [...new Set([...(fixes[key] ?? []), String(event.fixed)])];
      }
    }
  }

  const references: { type?: string; url?: string }[] = record.references ?? [];
  const url =
    references.find((r) => r.type === "ADVISORY" && r.url?.includes("github.com/advisories"))?.url ??
    (id.startsWith("GHSA-") ? `https://github.com/advisories/${id}` : `https://osv.dev/vulnerability/${id}`);

  const details = String(record.details ?? "").trim();
  return {
    id,
    aliases: [...new Set<string>(record.aliases ?? [])],
    summary: String(record.summary ?? "").trim() || firstSentence(details) || id,
    details,
    severity,
    cvss,
    malicious,
    published: record.published ?? null,
    modified: record.modified ?? null,
    withdrawn: record.withdrawn ?? null,
    url,
    fixes,
    ...(Object.keys(imports).length > 0 ? { imports } : {}),
  };
}

export async function fetchAdvisory(id: string): Promise<Advisory> {
  return normalizeAdvisory(await osvFetch(`/vulns/${encodeURIComponent(id)}`));
}

/** Which record to keep when several describe the same issue. */
function rank(advisory: Advisory): number {
  let score = 0;
  if (advisory.malicious) score += 8;
  if (advisory.id.startsWith("GHSA-")) score += 4; // reviewed, labelled, and has a readable page
  if (advisory.severity !== "unknown") score += 2;
  if (advisory.cvss !== null) score += 1;
  return score;
}

/**
 * Collapse advisories that describe the same vulnerability.
 *
 * One issue is routinely filed in several databases: a GHSA id, a PYSEC id and
 * a CVE all for the same bug. Reporting each would triple-count it. Records
 * are grouped when they share any id or alias, the best one is kept, and it
 * inherits the others' ids and fix versions.
 *
 * Returns the survivors and a map from every original id to its survivor's.
 */
export function mergeAdvisories(advisories: Advisory[]): { merged: Advisory[]; canonical: Map<string, string> } {
  // Union-find over every id and alias.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const advisory of advisories) {
    find(advisory.id);
    for (const alias of advisory.aliases) union(advisory.id, alias);
  }

  const groups = new Map<string, Advisory[]>();
  for (const advisory of advisories) {
    const root = find(advisory.id);
    groups.set(root, [...(groups.get(root) ?? []), advisory]);
  }

  const merged: Advisory[] = [];
  const canonical = new Map<string, string>();
  for (const group of groups.values()) {
    const [best, ...rest] = group.slice().sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
    const fixes: Record<string, string[]> = {};
    for (const advisory of group) {
      for (const [key, versions] of Object.entries(advisory.fixes)) {
        fixes[key] = [...new Set([...(fixes[key] ?? []), ...versions])];
      }
    }
    const ids = new Set(group.flatMap((a) => [a.id, ...a.aliases]));
    ids.delete(best.id);

    const imports: Record<string, string[]> = {};
    for (const advisory of group) {
      for (const [key, paths] of Object.entries(advisory.imports ?? {})) {
        imports[key] = [...new Set([...(imports[key] ?? []), ...paths])];
      }
    }

    merged.push({
      ...best,
      aliases: [...ids].sort(),
      fixes,
      malicious: group.some((a) => a.malicious),
      // A withdrawn duplicate does not withdraw the others.
      withdrawn: group.every((a) => a.withdrawn) ? best.withdrawn : null,
      cvss: best.cvss ?? rest.find((a) => a.cvss !== null && a.severity === best.severity)?.cvss ?? null,
      ...(Object.keys(imports).length > 0 ? { imports } : {}),
    });
    for (const advisory of group) canonical.set(advisory.id, best.id);
  }

  return { merged, canonical };
}
