import type { Dependency, Ecosystem, Inventory, Scope } from "@/lib/guard/types";

/**
 * A dependency list, packed for storage.
 *
 * The inventory is kept so an unchanged repo can be re-checked against new
 * advisories without reading it from GitHub again. A real project has several
 * hundred entries, and as objects each one repeats the same six property names
 * and the same lockfile path. Packed, an entry is a five-element array, which
 * is about a third of the size. On a free database tier that is the
 * difference that matters.
 *
 *   [ecosystem, name, version, flags, manifest]
 *
 * `flags` is a bit field and `manifest` is an index into `files`.
 */

const PINNED = 1;
const DIRECT = 2;
const DEV = 4;
const RUNTIME = 8;

type PackedDependency = [ecosystem: string, name: string, version: string, flags: number, manifest: number];

export interface PackedInventory {
  v: 1;
  method: Inventory["method"];
  manifests: string[];
  notes: string[];
  /** Distinct manifest paths that dependencies were read from. */
  files: string[];
  deps: PackedDependency[];
}

export function packInventory(inventory: Inventory): PackedInventory {
  const files: string[] = [];
  const indexOf = (manifest: string | undefined): number => {
    if (manifest === undefined) return -1;
    const found = files.indexOf(manifest);
    return found === -1 ? files.push(manifest) - 1 : found;
  };

  return {
    v: 1,
    method: inventory.method,
    manifests: inventory.manifests,
    notes: inventory.notes,
    deps: inventory.dependencies.map((d) => [
      d.ecosystem,
      d.name,
      d.version,
      (d.pinned ? PINNED : 0) | (d.direct ? DIRECT : 0) | (d.scope === "dev" ? DEV : d.scope === "runtime" ? RUNTIME : 0),
      indexOf(d.manifest),
    ]),
    files,
  };
}

/** The inverse of packInventory, or null for anything that is not one. */
export function unpackInventory(packed: unknown): Inventory | null {
  const p = packed as Partial<PackedInventory> | null;
  if (!p || p.v !== 1 || !Array.isArray(p.deps)) return null;
  const files = p.files ?? [];

  const dependencies: Dependency[] = p.deps.map(([ecosystem, name, version, flags, manifest]) => {
    const scope: Scope = flags & DEV ? "dev" : flags & RUNTIME ? "runtime" : "unknown";
    return {
      ecosystem: ecosystem as Ecosystem,
      name,
      version,
      pinned: Boolean(flags & PINNED),
      direct: Boolean(flags & DIRECT),
      scope,
      ...(manifest >= 0 && files[manifest] !== undefined ? { manifest: files[manifest] } : {}),
    };
  });

  return {
    dependencies,
    method: p.method ?? "lockfiles",
    manifests: p.manifests ?? [],
    notes: p.notes ?? [],
  };
}
