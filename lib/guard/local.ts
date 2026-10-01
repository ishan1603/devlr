import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { buildInventory } from "@/lib/guard/inventory";
import { isIgnoredPath, isManifestPath, type ManifestFile } from "@/lib/guard/lockfiles";
import { detectRuntimes, isRuntimePath, type DetectedRuntime } from "@/lib/guard/runtimes";
import type { Inventory } from "@/lib/guard/types";

/**
 * Read a checkout on disk instead of a repository on GitHub.
 *
 * Same files, same parsers, no network: this is what lets a branch be scanned
 * before it is pushed. Only used from scripts, never from the app.
 */

/** Never worth descending into, and often enormous. */
const SKIP = new Set([".git", "node_modules", ".next", ".turbo", ".cache", ".venv", "venv", "__pycache__", "coverage"]);
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 8_000_000;

export async function readLocalRepo(root: string): Promise<{ inventory: Inventory; runtimes: DetectedRuntime[] }> {
  const manifests: ManifestFile[] = [];
  const runtimeFiles: ManifestFile[] = [];

  async function walk(dir: string, relative: string, depth: number): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP.has(entry.name) && !isIgnoredPath(`${path}/`)) {
          await walk(join(dir, entry.name), path, depth + 1);
        }
        continue;
      }

      const manifest = isManifestPath(path);
      const runtime = isRuntimePath(path);
      if (!entry.isFile() || (!manifest && !runtime)) continue;

      const file = join(dir, entry.name);
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      const content = await readFile(file, "utf8");
      if (manifest) manifests.push({ path, content });
      if (runtime) runtimeFiles.push({ path, content });
    }
  }

  await walk(root, "", 0);
  return { inventory: buildInventory(manifests, null), runtimes: detectRuntimes(runtimeFiles) };
}
