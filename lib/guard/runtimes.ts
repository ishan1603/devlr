/**
 * Which language and service versions a repository actually runs.
 *
 * Feeds EOL Watch with something better than "you said you use Node": the
 * version pinned in the repo. Only files that state what is *run* are read
 * (.nvmrc, a Dockerfile's FROM line). Files that state a minimum, such as
 * `engines` in package.json or `requires-python`, are ignored on purpose:
 * "works on 18 or newer" does not mean anyone is still on 18, and warning
 * about it would be a false alarm.
 */

export interface DetectedRuntime {
  /** Product slug on endoflife.date. */
  product: string;
  /** Release cycle in that product's own numbering: "20", "3.10", "1.22". */
  cycle: string;
  /** The version string as written in the repo. */
  version: string;
  /** File it was read from. */
  source: string;
}

/** Root-level files that pin a runtime. */
export const RUNTIME_FILES = new Set([
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "runtime.txt",
  "go.mod",
]);

/**
 * "Dockerfile", "Dockerfile.prod", "api.dockerfile". Not "dockerfile.md": a
 * page of documentation with a FROM line in a code sample pins nothing.
 */
function isDockerfile(base: string): boolean {
  if (/\.(md|mdx|txt|rst|ya?ml|json|sh|ps1|bak|orig)$/i.test(base)) return false;
  return /^Dockerfile(\.[\w.-]+)?$|\.dockerfile$/i.test(base);
}

export function isRuntimePath(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  // Dockerfiles are often one level down (docker/, services/api/), so allow some depth.
  if (isDockerfile(base)) return parts.length <= 3;
  return parts.length === 1 && RUNTIME_FILES.has(base);
}

/** How many leading version segments identify a release cycle, per product. */
const CYCLE_PARTS: Record<string, number> = {
  nodejs: 1,
  postgresql: 1,
  python: 2,
  go: 2,
  ruby: 2,
  php: 2,
  redis: 2,
  nginx: 2,
  mysql: 2,
  mongodb: 2,
  ubuntu: 2,
  alpine: 2,
  "alpine-linux": 2,
};

/** Node's LTS codenames, as used in `.nvmrc` ("lts/iron"). */
const NODE_CODENAMES: Record<string, string> = {
  argon: "4", boron: "6", carbon: "8", dubnium: "10", erbium: "12", fermium: "14",
  gallium: "16", hydrogen: "18", iron: "20", jod: "22", krypton: "24",
};

/** Docker Hub image names that map onto a lifecycle product. */
const IMAGES: Record<string, string> = {
  node: "nodejs",
  python: "python",
  golang: "go",
  ruby: "ruby",
  php: "php",
  postgres: "postgresql",
  redis: "redis",
  nginx: "nginx",
  mysql: "mysql",
  mongo: "mongodb",
  ubuntu: "ubuntu",
  alpine: "alpine-linux",
};

/** asdf plugin names in `.tool-versions`. */
const TOOLS: Record<string, string> = {
  nodejs: "nodejs",
  node: "nodejs",
  python: "python",
  ruby: "ruby",
  golang: "go",
  go: "go",
  php: "php",
  postgres: "postgresql",
  redis: "redis",
};

function cycleOf(product: string, version: string): string | null {
  const numbers = version.match(/\d+(?:\.\d+)*/)?.[0];
  if (!numbers) return null;
  const parts = numbers.split(".");
  const wanted = CYCLE_PARTS[product] ?? 2;
  // "python 3" names no cycle; it could be any 3.x.
  if (parts.length < wanted) return null;
  return parts.slice(0, wanted).join(".");
}

function detected(product: string, version: string, source: string): DetectedRuntime | null {
  const cycle = cycleOf(product, version);
  return cycle ? { product, cycle, version: version.trim(), source } : null;
}

function parseNodeVersion(content: string, source: string): DetectedRuntime | null {
  const value = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  const codename = value.match(/^lts\/(\w+)$/i)?.[1]?.toLowerCase();
  if (codename) {
    const major = NODE_CODENAMES[codename];
    return major ? { product: "nodejs", cycle: major, version: value, source } : null;
  }
  // "node", "lts/*", "stable" and "latest" float, so they pin nothing.
  if (!/^v?\d/.test(value)) return null;
  return detected("nodejs", value, source);
}

function parseDockerfile(content: string, source: string): DetectedRuntime[] {
  const out: DetectedRuntime[] = [];
  for (const line of content.split(/\r?\n/)) {
    // FROM [--platform=...] [registry/][namespace/]image[:tag][@digest] [AS name]
    const match = line.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/i);
    if (!match) continue;
    const reference = match[1].split("@")[0];
    const colon = reference.lastIndexOf(":");
    if (colon === -1) continue; // no tag means "latest", which pins nothing
    const image = reference.slice(0, colon).split("/").pop()!.toLowerCase();
    const tag = reference.slice(colon + 1);
    const product = IMAGES[image];
    // A tag that starts with a build argument cannot be read statically.
    if (!product || !/^\d/.test(tag)) continue;
    const found = detected(product, tag, source);
    if (found) out.push(found);
  }
  return out;
}

/** Read every runtime the given files pin. One result per product and cycle. */
export function detectRuntimes(files: { path: string; content: string }[]): DetectedRuntime[] {
  const out: DetectedRuntime[] = [];
  const add = (runtime: DetectedRuntime | null) => {
    if (runtime) out.push(runtime);
  };

  for (const { path, content } of files) {
    const base = path.split("/").pop()!;
    const firstLine = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";

    if (base === ".nvmrc" || base === ".node-version") {
      add(parseNodeVersion(content, path));
    } else if (base === ".python-version") {
      // pyenv allows several versions; the first is the one in use.
      add(detected("python", firstLine.split(/\s+/)[0], path));
    } else if (base === ".ruby-version") {
      add(detected("ruby", firstLine.replace(/^ruby-/, ""), path));
    } else if (base === "runtime.txt") {
      const match = firstLine.match(/^python-(\d[\d.]*)/i);
      if (match) add(detected("python", match[1], path));
    } else if (base === ".tool-versions") {
      for (const line of content.split(/\r?\n/)) {
        const [tool, version] = line.trim().split(/\s+/);
        const product = tool ? TOOLS[tool.toLowerCase()] : undefined;
        if (product && version && /^\d/.test(version)) add(detected(product, version, path));
      }
    } else if (base === "go.mod") {
      // `toolchain` is what the module is built with. The `go` line is only a
      // minimum, so it is not read.
      const match = content.match(/^toolchain\s+go(\d[\d.]*)/m);
      if (match) add(detected("go", match[1], path));
    } else if (isDockerfile(base)) {
      out.push(...parseDockerfile(content, path));
    }
  }

  const seen = new Set<string>();
  return out.filter((runtime) => {
    const key = `${runtime.product}:${runtime.cycle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
