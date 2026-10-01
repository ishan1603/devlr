import { fetchJSON, mapLimit } from "@/lib/sources/http";
import { normalizePypiName } from "@/lib/guard/purl";
import type { Dependency, Ecosystem, ExploitIntel } from "@/lib/guard/types";

/**
 * Context that turns "this is vulnerable" into "this matters now".
 *
 *   CISA KEV    is it being exploited in the wild? A US government catalog,
 *               updated on working days.
 *   FIRST EPSS  how likely is exploitation in the next 30 days? A daily
 *               score per CVE.
 *   deps.dev    has the maintainer deprecated this exact version? Google's
 *               index of the package registries.
 *
 * All three are public, keyless and free. Each failure is isolated: losing
 * EPSS for a day lowers the precision of the ordering and nothing else.
 */

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const EPSS_URL = "https://api.first.org/data/v1/epss";
const DEPS_DEV = "https://api.deps.dev/v3";

/** CVE ids currently in CISA's Known Exploited Vulnerabilities catalog. */
export async function fetchKev(): Promise<Set<string>> {
  const data = await fetchJSON<{ vulnerabilities?: { cveID?: string }[] }>(KEV_URL, { timeoutMs: 30_000 });
  const ids = new Set<string>();
  for (const entry of data.vulnerabilities ?? []) if (entry.cveID) ids.add(entry.cveID.toUpperCase());
  return ids;
}

/** EPSS probability (0 to 1) per CVE. CVEs FIRST has not scored are absent. */
export async function fetchEpss(cves: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(cves.map((c) => c.toUpperCase()).filter((c) => /^CVE-\d{4}-\d+$/.test(c)))];
  const scores = new Map<string, number>();

  // Ids go in the query string, so they are sent in groups that keep the URL short.
  const groups: string[][] = [];
  for (let i = 0; i < unique.length; i += 80) groups.push(unique.slice(i, i + 80));

  const results = await mapLimit(groups, 3, (group) =>
    fetchJSON<{ data?: { cve: string; epss: string }[] }>(`${EPSS_URL}?cve=${group.join(",")}`, { timeoutMs: 20_000 })
  );
  for (const { result } of results) {
    for (const row of result?.data ?? []) {
      const value = Number(row.epss);
      if (Number.isFinite(value)) scores.set(row.cve.toUpperCase(), value);
    }
  }
  return scores;
}

/** The first CVE among an advisory's ids, which is what KEV and EPSS are keyed by. */
export function cveOf(ids: string[]): string | null {
  return ids.map((id) => id.toUpperCase()).find((id) => /^CVE-\d{4}-\d+$/.test(id)) ?? null;
}

export function intelFor(ids: string[], kev: Set<string>, epss: Map<string, number>): ExploitIntel {
  const cves = ids.map((id) => id.toUpperCase()).filter((id) => id.startsWith("CVE-"));
  const scores = cves.map((cve) => epss.get(cve)).filter((v): v is number => v !== undefined);
  return {
    kev: cves.some((cve) => kev.has(cve)),
    epss: scores.length > 0 ? Math.max(...scores) : null,
  };
}

// ---------------------------------------------------------------------------
// Deprecation
// ---------------------------------------------------------------------------

const DEPS_DEV_SYSTEMS: Partial<Record<Ecosystem, string>> = {
  npm: "npm",
  PyPI: "pypi",
  Go: "go",
  "crates.io": "cargo",
  Maven: "maven",
  NuGet: "nuget",
  RubyGems: "rubygems",
};

export interface Deprecation {
  reason: string;
}

/** Checking every transitive package would be thousands of requests for little gain. */
const MAX_DEPRECATION_CHECKS = 200;

export const deprecationKey = (d: Pick<Dependency, "ecosystem" | "name" | "version">) =>
  `${d.ecosystem}:${d.name}@${d.version}`;

export interface Deprecations {
  /** "ecosystem:name@version" -> notice, for every deprecated version found. */
  deprecated: Map<string, Deprecation>;
  /**
   * What this call learned, including "not deprecated" as null. A published
   * version's status rarely changes, so the caller can keep these and pass
   * them back as `known` next time instead of asking again.
   */
  learned: Map<string, Deprecation | null>;
}

/**
 * Which of these exact versions has its maintainer marked deprecated.
 *
 * Only direct dependencies are worth asking about: they are the ones a reader
 * chose and can replace.
 */
export async function fetchDeprecations(
  dependencies: Dependency[],
  known: Map<string, Deprecation | null> = new Map()
): Promise<Deprecations> {
  const eligible = dependencies.filter((d) => d.direct && d.pinned && DEPS_DEV_SYSTEMS[d.ecosystem]);
  const candidates = eligible.filter((d) => !known.has(deprecationKey(d))).slice(0, MAX_DEPRECATION_CHECKS);

  const out = new Map<string, Deprecation>();
  for (const d of eligible) {
    const cached = known.get(deprecationKey(d));
    if (cached) out.set(deprecationKey(d), cached);
  }

  const learned = new Map<string, Deprecation | null>();
  const results = await mapLimit(candidates, 8, async (d) => {
    const name = d.ecosystem === "PyPI" ? normalizePypiName(d.name) : d.name;
    const url = `${DEPS_DEV}/systems/${DEPS_DEV_SYSTEMS[d.ecosystem]}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(d.version)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    // A package deps.dev has not indexed is simply unknown, not an error.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`deps.dev answered ${response.status}`);
    return (await response.json()) as { isDeprecated?: boolean; deprecatedReason?: string };
  });

  for (const { item, result, error } of results) {
    // A failed lookup is not an answer. It is left out so it is asked again.
    if (error) continue;
    const notice = result?.isDeprecated ? { reason: String(result.deprecatedReason ?? "").trim() } : null;
    learned.set(deprecationKey(item), notice);
    if (notice) out.set(deprecationKey(item), notice);
  }
  return { deprecated: out, learned };
}
