import { parseManifests, type ManifestFile } from "@/lib/guard/lockfiles";
import type { Dependency, Inventory } from "@/lib/guard/types";

/**
 * Deciding what a repository depends on, from the two sources available.
 *
 * Lockfiles come first. They say exactly what was installed, which of it the
 * repo asked for itself, what is dev-only, and which package manager wrote
 * them, and all four of those change what a reader is told. They also let
 * fixtures and vendored code be left out by path.
 *
 * GitHub's dependency graph fills in whatever the lockfiles do not cover:
 * ecosystems with no parser here (Maven, NuGet, Gradle, Actions), and repos too
 * large to read file by file. It is not merged in for an ecosystem the
 * lockfiles already answered, because the graph cannot say which manifest a
 * package came from, and would bring back every example and fixture.
 */

const GRAPH = "GitHub dependency graph";

export function buildInventory(
  files: ManifestFile[],
  graph: Dependency[] | null,
  options: { /** The file listing was cut short, so the lockfiles read are not all of them. */ truncated?: boolean } = {}
): Inventory {
  const parsed = parseManifests(files);
  const notes = [...parsed.notes];
  const fromGraph = graph ?? [];

  // An incomplete read of a huge repo loses to a complete graph, provided the
  // graph has real versions to offer.
  if (options.truncated && fromGraph.length > 0) {
    const pinned = fromGraph.filter((d) => d.pinned).length;
    if (pinned / fromGraph.length >= 0.5) {
      return { dependencies: fromGraph, method: "sbom", manifests: [GRAPH], notes: [] };
    }
  }

  const answered = new Set(parsed.dependencies.map((d) => d.ecosystem));
  const extra = fromGraph.filter((d) => !answered.has(d.ecosystem));
  const dependencies = [...parsed.dependencies, ...extra];

  if (dependencies.length === 0) {
    notes.push(
      files.length === 0
        ? "No dependency manifests were found in this repository."
        : "Manifests were found, but none in a format Devlr can read yet."
    );
  }

  return {
    dependencies,
    method: parsed.dependencies.length === 0 && extra.length > 0 ? "sbom" : extra.length > 0 ? "both" : "lockfiles",
    manifests: [...parsed.manifests, ...(extra.length > 0 ? [GRAPH] : [])],
    notes,
  };
}
