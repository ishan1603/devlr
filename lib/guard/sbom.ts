import { isPinned, packageKey, parsePurl } from "@/lib/guard/purl";
import type { Dependency } from "@/lib/guard/types";

/**
 * Reading GitHub's dependency-graph export (SPDX 2.3 JSON).
 *
 * One request covers every ecosystem GitHub understands, and when the repo has
 * a lockfile the export carries the whole graph, so direct and transitive
 * dependencies can be told apart. Two things to know about it:
 *
 *   - Without a lockfile, versions are the ranges from the manifest
 *     ("^4.17.0"). Those are kept but marked unpinned: a range cannot be
 *     matched against an advisory.
 *   - It only exists when the repository's dependency graph is switched on.
 *     Otherwise the endpoint answers 404 and the lockfile parsers take over.
 */

interface SpdxPackage {
  SPDXID: string;
  name?: string;
  versionInfo?: string;
  externalRefs?: { referenceType?: string; referenceLocator?: string }[];
}

interface SpdxRelationship {
  spdxElementId: string;
  relatedSpdxElement: string;
  relationshipType: string;
}

export interface SpdxDocument {
  packages?: SpdxPackage[];
  relationships?: SpdxRelationship[];
}

function purlOf(pkg: SpdxPackage): string | null {
  return pkg.externalRefs?.find((ref) => ref.referenceType === "purl")?.referenceLocator ?? null;
}

export function parseSpdx(document: SpdxDocument): Dependency[] {
  const packages = document.packages ?? [];
  const relationships = document.relationships ?? [];

  // The repository itself is the package the document DESCRIBES. Whatever it
  // DEPENDS_ON directly is a direct dependency; everything else arrived
  // through something else.
  const roots = new Set(
    relationships.filter((r) => r.relationshipType === "DESCRIBES").map((r) => r.relatedSpdxElement)
  );
  for (const pkg of packages) {
    if (purlOf(pkg)?.startsWith("pkg:github/")) roots.add(pkg.SPDXID);
  }

  const direct = new Set(
    relationships
      .filter((r) => r.relationshipType === "DEPENDS_ON" && roots.has(r.spdxElementId))
      .map((r) => r.relatedSpdxElement)
  );
  // Older exports list packages with no edges at all. With nothing to say
  // otherwise, a listed package is treated as declared by the repo.
  const hasGraph = direct.size > 0;

  const byKey = new Map<string, Dependency>();
  for (const pkg of packages) {
    if (roots.has(pkg.SPDXID)) continue;
    const purl = purlOf(pkg);
    const parsed = purl ? parsePurl(purl) : null;
    if (!parsed) continue;

    const version = parsed.version || pkg.versionInfo || "";
    const key = `${packageKey(parsed.ecosystem, parsed.name)}@${version}`;
    const isDirect = hasGraph ? direct.has(pkg.SPDXID) : true;

    const existing = byKey.get(key);
    if (existing) {
      // The same package can appear once per manifest. Direct anywhere is direct.
      existing.direct = existing.direct || isDirect;
      continue;
    }

    byKey.set(key, {
      ecosystem: parsed.ecosystem,
      name: parsed.name,
      version,
      pinned: isPinned(version),
      direct: isDirect,
      // The export does not say whether something is a dev dependency.
      scope: "unknown",
      manifest: "dependency graph",
    });
  }

  return dropRedundantRanges([...byKey.values()]);
}

/**
 * Remove range entries for packages that also appear with an exact version.
 *
 * A dependency graph built from both a manifest and its lockfile lists each
 * package twice: once as the range the manifest asks for ("^1.4") and once as
 * what the lockfile resolved ("1.4.1"). The range adds nothing and would be
 * reported as "could not be checked", which is false. Its one useful fact,
 * that the repo asked for the package itself, is carried over.
 */
export function dropRedundantRanges(dependencies: Dependency[]): Dependency[] {
  const resolved = new Map<string, Dependency[]>();
  for (const d of dependencies) {
    if (!d.pinned) continue;
    const key = packageKey(d.ecosystem, d.name);
    resolved.set(key, [...(resolved.get(key) ?? []), d]);
  }

  return dependencies.filter((d) => {
    if (d.pinned) return true;
    const exact = resolved.get(packageKey(d.ecosystem, d.name));
    if (!exact) return true;
    if (d.direct) for (const match of exact) match.direct = true;
    return false;
  });
}
