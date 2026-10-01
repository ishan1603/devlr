import { isPinned, normalizePypiName, packageKey } from "@/lib/guard/purl";
import type { Dependency, Ecosystem, Scope } from "@/lib/guard/types";

/**
 * Reading dependencies straight from lockfiles.
 *
 * This is the path taken when GitHub's dependency graph is switched off, which
 * turned out to be the case for this project's own repository. A lockfile is
 * also the more precise source: it records exactly what was installed.
 *
 * Every parser here is deliberately small and format-specific. None of them
 * evaluates anything or resolves a version range: they read what the lockfile
 * says was resolved. Formats that would normally need a YAML or TOML parser
 * are read line by line, relying on the fact that these files are
 * machine-written and therefore regular.
 *
 * Only packages that came from a registry are reported. A lockfile also lists
 * the repo's own workspace packages, and anything installed from a path or a
 * git remote. Those have a name and a version too, but checking them against
 * registry advisories by name would be guessing: a private package called
 * "utils" would be accused of the public one's bugs.
 */

export interface ManifestFile {
  path: string;
  content: string;
}

/** Files worth fetching from a repository, by base name. */
export const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.mod",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

const REQUIREMENTS_FILE = /^requirements[\w.-]*\.txt$/i;

/** Is this file one of the manifests we know how to read? */
export function isManifestPath(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  if (MANIFEST_NAMES.has(base)) return true;
  if (REQUIREMENTS_FILE.test(base)) return true;
  // requirements/prod.txt, requirements/dev.txt
  return parts.length >= 2 && parts[parts.length - 2].toLowerCase() === "requirements" && base.endsWith(".txt");
}

/** Vendored code and fixtures are someone else's dependencies, not this repo's. */
export function isIgnoredPath(path: string): boolean {
  return /(^|\/)(node_modules|vendor|third_party|\.venv|venv|dist|build|target|fixtures?|testdata|__fixtures__|examples?|\.git)\//i.test(
    path
  );
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, "");

/** A workspace has several manifests behind one lockfile, so parsers accept one or many. */
type OneOrMany = string | string[] | undefined;
const many = (value: OneOrMany): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function dep(
  ecosystem: Ecosystem,
  name: string,
  version: string,
  manifest: string,
  direct: boolean,
  scope: Scope
): Dependency {
  return { ecosystem, name, version, pinned: isPinned(version), direct, scope, manifest };
}

/** `resolved` values in package-lock.json that are not a registry tarball. */
const NOT_A_REGISTRY_URL = /^(git|file:|github:)|^https?:\/\/(codeload\.)?github\.com\//;

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// npm: package.json + package-lock.json | pnpm-lock.yaml | yarn.lock
// ---------------------------------------------------------------------------

interface Declared {
  /** name -> the range asked for ("" when only the name is known). */
  runtime: Map<string, string>;
  dev: Map<string, string>;
}

function declaredNpm(packageJson: string | undefined): Declared {
  const json = packageJson ? safeJson(packageJson) : null;
  const runtime = new Map<string, string>();
  const dev = new Map<string, string>();
  for (const [name, range] of Object.entries({ ...json?.dependencies, ...json?.optionalDependencies })) {
    runtime.set(name, String(range));
  }
  for (const [name, range] of Object.entries(json?.devDependencies ?? {})) dev.set(name, String(range));
  return { runtime, dev };
}

const isDeclared = (name: string, declared: Declared) => declared.runtime.has(name) || declared.dev.has(name);

function scopeOf(name: string, declared: Declared, fallback: Scope): Scope {
  if (declared.runtime.has(name)) return "runtime";
  if (declared.dev.has(name)) return "dev";
  return fallback;
}

export function parsePackageLock(content: string, path: string, packageJson?: string): Dependency[] {
  const lock = safeJson(content);
  if (!lock) return [];
  const declared = declaredNpm(packageJson);
  const out: Dependency[] = [];
  const marker = "node_modules/";

  if (lock.packages && typeof lock.packages === "object") {
    // v2 and v3: a flat map keyed by install path.
    //
    //   ""                              the repo itself
    //   "packages/api"                  a workspace package
    //   "node_modules/a"                what the repo (or a workspace) resolved "a" to
    //   "node_modules/a/node_modules/b" a copy of "b" private to "a"
    //
    // The first two kinds carry the declarations; a workspace's dependencies
    // are as direct as the root's.
    for (const [key, entry] of Object.entries<any>(lock.packages)) {
      if (key.includes(marker)) continue;
      for (const name of Object.keys({ ...entry?.dependencies, ...entry?.optionalDependencies })) {
        if (!declared.runtime.has(name)) declared.runtime.set(name, "");
      }
      for (const name of Object.keys(entry?.devDependencies ?? {})) {
        if (!isDeclared(name, declared)) declared.dev.set(name, "");
      }
    }

    for (const [key, entry] of Object.entries<any>(lock.packages)) {
      const at = key.lastIndexOf(marker);
      // `link: true` is a symlink to a workspace package, not an install.
      if (at === -1 || !entry?.version || entry.link) continue;
      if (typeof entry.resolved === "string" && NOT_A_REGISTRY_URL.test(entry.resolved)) continue;
      const name = key.slice(at + marker.length);
      // Nested under another package's node_modules means it belongs to that
      // package, whatever the repo declares.
      const nested = key.slice(0, at).includes(marker);
      const scope: Scope = entry.dev ? "dev" : scopeOf(name, declared, "runtime");
      out.push(dep("npm", name, String(entry.version), path, !nested && isDeclared(name, declared), scope));
    }
    return out;
  }

  // v1: a nested tree. Only the top level can be direct.
  const walk = (tree: Record<string, any> | undefined, depth: number) => {
    for (const [name, entry] of Object.entries(tree ?? {})) {
      // In a v1 lock a git or path install has its URL where the version goes.
      if (!entry?.version || !isPinned(String(entry.version))) continue;
      const scope: Scope = entry.dev ? "dev" : scopeOf(name, declared, "runtime");
      out.push(dep("npm", name, String(entry.version), path, depth === 0 && isDeclared(name, declared), scope));
      walk(entry.dependencies, depth + 1);
    }
  };
  walk(lock.dependencies, 0);
  return out;
}

/**
 * Split a key from pnpm's `packages:` section into name and version.
 *
 * The key format changed twice:
 *   v5      /name/1.2.3            /@scope/name/1.2.3_peer@4.5.6
 *   v6      /name@1.2.3            /@scope/name@1.2.3(peer@4.5.6)
 *   v9       name@1.2.3             '@scope/name@1.2.3'
 *
 * The suffix after the version records which peers it was installed with. It
 * says nothing about which package this is, so it is dropped.
 */
export function splitPnpmKey(raw: string, lockfileMajor: number): [string, string] | null {
  const key = unquote(raw).replace(/^\//, "");
  if (!key) return null;

  if (lockfileMajor < 6) {
    const slash = key.lastIndexOf("/");
    if (slash <= 0) return null;
    return [key.slice(0, slash), key.slice(slash + 1).replace(/_.*$/, "")];
  }

  const withoutPeers = key.replace(/\(.*$/, "");
  const at = withoutPeers.lastIndexOf("@");
  if (at <= 0) return null;
  return [withoutPeers.slice(0, at), withoutPeers.slice(at + 1)];
}

const PNPM_GROUPS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

export function parsePnpmLock(content: string, path: string, packageJson?: string): Dependency[] {
  const declared = declaredNpm(packageJson);
  const lines = content.split(/\r?\n/);
  const major = Math.floor(Number(content.match(/^lockfileVersion:\s*['"]?([\d.]+)/m)?.[1] ?? 9));

  // What the repo's own packages resolved to. When two versions of a package
  // coexist, this is what identifies the one that was asked for directly.
  const directVersions = new Map<string, Set<string>>();
  const devNames = new Set<string>();
  const record = (name: string, version: string, group: string) => {
    const clean = unquote(version).replace(/\(.*$/, "").replace(/_.*$/, "");
    if (!clean || /^(link|workspace|file):/.test(clean)) return;
    const set = directVersions.get(name) ?? new Set<string>();
    set.add(clean);
    directVersions.set(name, set);
    if (group === "devDependencies") devNames.add(name);
  };

  let section = "";
  let group = "";
  let current = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (indent === 0) {
      section = text.replace(/:.*$/, "");
      // A single-package lockfile puts the groups at the top level.
      group = PNPM_GROUPS.has(section) ? section : "";
      current = "";
      continue;
    }

    // In a workspace they are nested: importers -> <package path> -> group.
    const inImporters = section === "importers";
    if (!inImporters && !PNPM_GROUPS.has(section)) continue;
    const nameIndent = inImporters ? 6 : 2;

    if (inImporters && indent < nameIndent) {
      group = indent === 4 && PNPM_GROUPS.has(text.replace(/:$/, "")) ? text.replace(/:$/, "") : "";
      current = "";
      continue;
    }
    if (!group) continue;

    if (indent === nameIndent) {
      const match = text.match(/^(['"]?)(.+?)\1:\s*(.*)$/);
      if (!match) continue;
      current = match[2];
      // v5 writes "name: 1.2.3" on one line; later versions nest the version.
      if (match[3]) record(current, match[3], group);
    } else if (indent === nameIndent + 2 && current && text.startsWith("version:")) {
      record(current, text.slice("version:".length), group);
    }
  }

  const out: Dependency[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:/.test(line);
      continue;
    }
    // Package keys sit at exactly two spaces; their fields are deeper.
    if (!inPackages || !/^ {2}\S.*:\s*$/.test(line)) continue;

    const parsed = splitPnpmKey(line.trim().replace(/:\s*$/, ""), major);
    if (!parsed) continue;
    const [name, version] = parsed;
    // "forked@https://codeload.github.com/..." has a URL where the version goes.
    if (!isPinned(version)) continue;
    const isDirect = directVersions.get(name)?.has(version) ?? false;
    const scope: Scope = isDirect
      ? devNames.has(name) && !declared.runtime.has(name)
        ? "dev"
        : "runtime"
      : scopeOf(name, declared, "unknown");
    out.push(dep("npm", name, version, path, isDirect, scope));
  }
  return out;
}

/** Ranges that point somewhere other than the registry: the repo itself, a path, a git remote. */
const NOT_A_REGISTRY_RANGE = /^(workspace|portal|link|file|exec|git|github|gitlab|bitbucket|ssh|https?):|^git\+|:\/\//;
/** "left-pad@^1.3.0" as a range: an alias, installing left-pad under another name. */
const ALIAS_RANGE = /^(@?[^@\s:]+)@/;

/** What a yarn range points at, with the `npm:` prefix already removed. */
function yarnRange(range: string): { registry: boolean; realName?: string } {
  // A patched package is still that package: its advisories apply.
  if (range.startsWith("patch:")) return { registry: true };
  const alias = range.match(ALIAS_RANGE);
  if (alias) return { registry: true, realName: alias[1] };
  // A semver range never has a slash in it. "owner/repo#ref" does.
  return { registry: !NOT_A_REGISTRY_RANGE.test(range) && !range.includes("/") };
}

export function parseYarnLock(content: string, path: string, packageJson?: OneOrMany): Dependency[] {
  // In a workspace every member's package.json sits behind this one lockfile.
  const declared = many(packageJson).map(declaredNpm);
  const rangesFor = (name: string) =>
    declared.flatMap((d) => [d.runtime.get(name), d.dev.get(name)]).filter((r): r is string => r !== undefined);
  const scopeFor = (name: string): Scope =>
    declared.some((d) => d.runtime.has(name)) ? "runtime" : declared.some((d) => d.dev.has(name)) ? "dev" : "unknown";

  const out: Dependency[] = [];
  let specs: string[] = [];

  /**
   * "lodash@^4.17.20" and "lodash@npm:^4.17.20" both give ["lodash", "^4.17.20"].
   * The name ends at the first "@" that is not a scope marker, because the
   * range can contain one of its own ("resolve@patch:resolve@^1.20.0#...").
   */
  const splitSpec = (spec: string): [string, string] | null => {
    const clean = unquote(spec);
    const at = clean.indexOf("@", 1);
    if (at <= 0) return null;
    return [clean.slice(0, at), clean.slice(at + 1).replace(/^npm:/, "")];
  };

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;

    // An unindented line ending in ":" opens an entry and lists every range it satisfies.
    if (/^\S/.test(line) && line.trimEnd().endsWith(":")) {
      specs = line.trimEnd().slice(0, -1).split(/,\s*/);
      continue;
    }

    // Classic writes `version "1.2.3"`, Berry writes `version: 1.2.3`.
    const match = line.match(/^\s+version:?\s+["']?([^"'\s]+)["']?/);
    if (!match || specs.length === 0) continue;

    const pairs = specs.map(splitSpec).filter(Boolean) as [string, string][];
    specs = [];
    if (pairs.length === 0) continue;
    const alias = pairs[0][0];
    if (alias === "__metadata") continue;

    // The repo's own workspace packages, and anything fetched from a path or
    // a git remote, are not registry packages.
    const ranges = pairs.map(([, range]) => yarnRange(range));
    if (match[1] === "0.0.0-use.local" || !ranges.some((r) => r.registry)) continue;

    // An alias ("foo@npm:bar@^1.0.0") installs bar under the name foo. The
    // advisory, if there is one, is filed against bar.
    const name = ranges.find((r) => r.realName)?.realName ?? alias;

    // Direct if one of the ranges this entry satisfies is one a package.json asks for.
    const wanted = rangesFor(alias).map((range) => range.replace(/^npm:/, ""));
    const isDirect = pairs.some(([, range]) => wanted.includes(range));
    out.push(dep("npm", name, match[1], path, isDirect, scopeFor(alias)));
  }
  return out;
}

/**
 * bun.lock: JSON with trailing commas.
 *
 * `workspaces` records what each package in the repo asked for. `packages`
 * maps an install path to ["name@version", registry, metadata, integrity],
 * where a path with a parent in it ("string-width/strip-ansi") is a copy that
 * belongs to that parent.
 */
export function parseBunLock(content: string, path: string): Dependency[] {
  // Trailing commas are all that stands between this file and JSON.
  const lock = safeJson(content.replace(/,(\s*[}\]])/g, "$1"));
  if (!lock?.packages || typeof lock.packages !== "object") return [];

  const runtime = new Set<string>();
  const dev = new Set<string>();
  for (const workspace of Object.values<any>(lock.workspaces ?? {})) {
    for (const name of Object.keys({ ...workspace?.dependencies, ...workspace?.optionalDependencies })) runtime.add(name);
    for (const name of Object.keys(workspace?.devDependencies ?? {})) dev.add(name);
  }

  const out: Dependency[] = [];
  for (const [key, entry] of Object.entries<any>(lock.packages)) {
    const resolved = Array.isArray(entry) ? String(entry[0] ?? "") : "";
    const at = resolved.lastIndexOf("@");
    if (at <= 0) continue;
    const name = resolved.slice(0, at);
    const version = resolved.slice(at + 1);
    // "name@workspace:packages/a", "name@github:owner/repo#sha": not registry installs.
    if (version.includes(":")) continue;

    const topLevel = key.startsWith("@") ? key.split("/").length === 2 : !key.includes("/");
    // The key is the name it was asked for under, which differs for an alias.
    const asked = [key, name].find((n) => runtime.has(n) || dev.has(n));
    const scope: Scope = asked === undefined ? "unknown" : runtime.has(asked) ? "runtime" : "dev";
    out.push(dep("npm", name, version, path, topLevel && asked !== undefined, scope));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

export function parseRequirements(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  const scope: Scope = /dev|test|lint|docs/i.test(path) ? "dev" : "runtime";
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    // Drop trailing comments, environment markers and line continuations.
    const line = lines[i].split(" #")[0].split(";")[0].replace(/\s*\\$/, "").trim();
    // Options ("-r other.txt", "-e ."), comments and direct URLs name no version.
    if (!line || line.startsWith("#") || line.startsWith("-") || line.includes("://")) continue;

    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/);
    if (!match) continue;
    const spec = match[2].split("--hash")[0].trim();
    const exact = spec.match(/^===?\s*([^\s,]+)$/);

    // pip-compile annotates each pin with what required it. A pin that is only
    // there "via" another package is transitive.
    let via = "";
    for (let j = i + 1; j < lines.length && /^\s+#/.test(lines[j]); j++) via += lines[j];
    const transitive = /#\s*via\b/.test(via) && !/-r\s|pyproject\.toml|setup\.(py|cfg)/.test(via);

    out.push(dep("PyPI", normalizePypiName(match[1]), exact ? exact[1] : spec, path, !transitive, scope));
  }
  return out;
}

/**
 * Names declared in pyproject.toml.
 *
 * Only the tables that actually list dependencies are read. Reading every
 * array would turn `classifiers` and `authors` into dependencies.
 */
export function declaredPython(pyproject: string | undefined): Set<string> {
  const names = new Set<string>();
  if (!pyproject) return names;

  const addRequirement = (text: string) => {
    for (const item of text.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(normalizePypiName(item[1]));
  };

  let table = "";
  let collecting = false;
  for (const line of pyproject.split(/\r?\n/)) {
    if (collecting) {
      addRequirement(line.split("]")[0]);
      if (line.includes("]")) collecting = false;
      continue;
    }

    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      table = header[1].trim();
      continue;
    }

    const assignment = line.match(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*(.*)$/);
    if (!assignment) continue;
    const [, key, value] = assignment;

    // PEP 621 and PEP 735: arrays of requirement strings.
    const listsRequirements =
      (table === "project" && key === "dependencies") ||
      table === "project.optional-dependencies" ||
      table === "dependency-groups" ||
      (table === "tool.uv" && key === "dev-dependencies");
    if (listsRequirements && value.trimStart().startsWith("[")) {
      addRequirement(value.split("]")[0]);
      collecting = !value.includes("]");
      continue;
    }

    // Poetry: one key per dependency.
    if (/^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/.test(table) && key.toLowerCase() !== "python") {
      names.add(normalizePypiName(key));
    }
  }
  return names;
}

interface TomlPackage {
  name: string;
  version: string;
  /** The package's own fields. */
  body: string;
  /** Those fields plus its sub-tables, such as [package.source]. */
  block: string;
}

/** `[[package]]` tables with a name and a version: poetry.lock, uv.lock, Cargo.lock. */
function tomlPackages(content: string): TomlPackage[] {
  const out: TomlPackage[] = [];
  for (const block of content.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    // Stop at the next table, so [package.dependencies] is not read as this package's fields.
    const body = block.split(/^\[/m)[0];
    const name = body.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = body.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) out.push({ name, version, body, block });
  }
  return out;
}

/**
 * Did this Python package come from somewhere other than an index?
 *
 *   uv       source = { editable = "." }        the project itself
 *            source = { git = "https://..." }
 *   poetry   [package.source] with type = "directory" | "git" | "file" | "url"
 */
function isLocalPython({ body, block }: TomlPackage): boolean {
  if (/^source\s*=\s*\{\s*(editable|virtual|directory|path|git|url)\s*=/m.test(body)) return true;
  const source = block.match(/^\[package\.source\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return /^type\s*=\s*"(directory|git|file|url)"/m.test(source);
}

export function parsePythonLock(content: string, path: string, pyproject?: OneOrMany): Dependency[] {
  const declared = new Set(many(pyproject).flatMap((text) => [...declaredPython(text)]));
  return tomlPackages(content).filter((pkg) => !isLocalPython(pkg)).map(({ name, version, body }) => {
    const normalized = normalizePypiName(name);
    // Older Poetry wrote `category`; newer versions write `groups`.
    const groups = body.match(/^groups\s*=\s*\[([^\]]*)\]/m)?.[1];
    const dev = /^category\s*=\s*"dev"/m.test(body) || (groups !== undefined && !groups.includes('"main"'));
    return dep("PyPI", normalized, version, path, declared.has(normalized), dev ? "dev" : "runtime");
  });
}

export function parsePipfileLock(content: string, path: string): Dependency[] {
  const lock = safeJson(content);
  if (!lock) return [];
  const out: Dependency[] = [];
  for (const [section, scope] of [["default", "runtime"], ["develop", "dev"]] as const) {
    for (const [name, entry] of Object.entries<any>(lock[section] ?? {})) {
      const version = String(entry?.version ?? "").replace(/^==/, "");
      // The lock does not record which entries the Pipfile asked for.
      if (version) out.push(dep("PyPI", normalizePypiName(name), version, path, false, scope));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Go, Rust, Ruby, PHP
// ---------------------------------------------------------------------------

export function parseGoMod(content: string, path: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = content.split(/\r?\n/).map((line) => line.trim());

  // `replace example.com/lib => ../lib` swaps a module for a directory in the
  // repo. Its required version is a placeholder, not something published.
  const local = new Set<string>();
  let inReplace = false;
  for (const line of lines) {
    if (/^replace\s*\($/.test(line)) inReplace = true;
    else if (inReplace && line === ")") inReplace = false;
    const body = inReplace ? line : line.startsWith("replace ") ? line.slice("replace ".length).trim() : "";
    const match = body.match(/^(\S+)(?:\s+v\S+)?\s*=>\s*(\S+)/);
    if (match && /^(\.|\/|[A-Za-z]:[\\/])/.test(match[2])) local.add(match[1]);
  }

  let inRequire = false;
  for (const line of lines) {
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const body = inRequire ? line : line.startsWith("require ") ? line.slice("require ".length).trim() : "";
    // Since Go 1.17, go.mod lists everything needed and marks what it did not ask for.
    const match = body.match(/^(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/);
    if (match && !local.has(match[1])) out.push(dep("Go", match[1], match[2], path, !match[3], "runtime"));
  }
  return out;
}

export function declaredCargo(cargoToml: string | undefined): { runtime: Set<string>; dev: Set<string> } {
  const runtime = new Set<string>();
  const dev = new Set<string>();
  let target: Set<string> | null = null;

  for (const line of (cargoToml ?? "").split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const table = header[1].trim();
      // "[dependencies.serde]" declares serde by itself.
      const single = table.match(/(?:^|\.)(dev-|build-)?dependencies\.([\w-]+)$/);
      if (single) {
        (single[1] === "dev-" ? dev : runtime).add(single[2]);
        target = null;
        continue;
      }
      target = /(^|\.)dev-dependencies$/.test(table) ? dev : /(^|\.)(build-)?dependencies$/.test(table) ? runtime : null;
      continue;
    }
    const key = target ? line.match(/^\s*([\w-]+)\s*=/) : null;
    if (!key) continue;
    // `log2 = { package = "log", version = "0.4" }` depends on log, under another name.
    const renamed = line.match(/\bpackage\s*=\s*"([\w-]+)"/);
    target!.add(renamed ? renamed[1] : key[1]);
  }
  return { runtime, dev };
}

export function parseCargoLock(content: string, path: string, cargoToml?: OneOrMany): Dependency[] {
  // A workspace has one Cargo.lock and a Cargo.toml per member crate.
  const declared = { runtime: new Set<string>(), dev: new Set<string>() };
  for (const text of many(cargoToml)) {
    const found = declaredCargo(text);
    for (const name of found.runtime) declared.runtime.add(name);
    for (const name of found.dev) declared.dev.add(name);
  }
  return (
    tomlPackages(content)
      // No `source` means it is a crate in this workspace, and a git source is
      // someone's fork. Only crates from a registry are checked.
      .filter(({ body }) => /^source\s*=\s*"(registry|sparse)\+/m.test(body))
      .map(({ name, version }) =>
        dep(
          "crates.io",
          name,
          version,
          path,
          declared.runtime.has(name) || declared.dev.has(name),
          declared.dev.has(name) && !declared.runtime.has(name) ? "dev" : "runtime"
        )
      )
  );
}

export function parseGemfileLock(content: string, path: string): Dependency[] {
  const specs: [string, string][] = [];
  const direct = new Set<string>();
  let section = "";
  let inSpecs = false;

  for (const line of content.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.trim();
      inSpecs = false;
      continue;
    }
    if (line.trim() === "specs:") {
      inSpecs = true;
      continue;
    }
    if (inSpecs && section === "GEM") {
      // Four spaces is a resolved gem; six is one of its own requirements.
      const match = line.match(/^ {4}(\S+) \(([^)]+)\)$/);
      if (match) specs.push([match[1], match[2]]);
    } else if (section === "DEPENDENCIES") {
      const match = line.match(/^ {2}([^\s!]+)/);
      if (match) direct.add(match[1]);
    }
  }

  return specs.map(([name, version]) =>
    // "1.16.0-x86_64-linux" is 1.16.0 built for a platform.
    dep("RubyGems", name, version.replace(/-(x86|x64|arm|aarch|java|universal|mingw|mswin|darwin|linux|musl).*$/i, ""), path, direct.has(name), "runtime")
  );
}

export function parseComposerLock(content: string, path: string, composerJson?: string): Dependency[] {
  const lock = safeJson(content);
  if (!lock) return [];
  const json = composerJson ? safeJson(composerJson) : null;
  const declared = new Set([...Object.keys(json?.require ?? {}), ...Object.keys(json?.["require-dev"] ?? {})]);

  const out: Dependency[] = [];
  for (const [section, scope] of [["packages", "runtime"], ["packages-dev", "dev"]] as const) {
    for (const entry of lock[section] ?? []) {
      if (!entry?.name || !entry?.version) continue;
      // A path repository is a directory in this repo, not a Packagist release.
      if (entry.dist?.type === "path") continue;
      // Composer tags are usually "v6.4.0"; Packagist and OSV drop the prefix.
      const version = String(entry.version).replace(/^v(?=\d)/, "");
      out.push(dep("Packagist", String(entry.name), version, path, declared.has(entry.name), scope));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];
const PYTHON_LOCKS = ["poetry.lock", "uv.lock"];

/**
 * Parse every manifest in a repository.
 *
 * Files are grouped by directory so a lockfile is read alongside the manifest
 * that sits next to it, which is how each package in a monorepo gets its own
 * idea of what is "direct".
 */
export function parseManifests(files: ManifestFile[]): {
  dependencies: Dependency[];
  manifests: string[];
  notes: string[];
} {
  const byDir = new Map<string, Map<string, ManifestFile>>();
  for (const file of files) {
    if (isIgnoredPath(file.path)) continue;
    const dir = dirOf(file.path);
    const group = byDir.get(dir) ?? new Map<string, ManifestFile>();
    group.set(file.path.slice(dir ? dir.length + 1 : 0), file);
    byDir.set(dir, group);
  }

  const all: Dependency[] = [];
  const manifests: string[] = [];
  const notes: string[] = [];

  /** The closest directory at or above `dir` that holds one of these lockfiles. */
  const lockDirFor = (dir: string, locks: string[]): string | null => {
    for (let current = dir; ; current = dirOf(current)) {
      const group = byDir.get(current);
      if (group && locks.some((name) => group.has(name))) return current;
      if (current === "") return null;
    }
  };

  const coveredByNpmLock = (dir: string) => lockDirFor(dir, NPM_LOCKS) !== null;

  /**
   * Every `name` manifest that the lockfile in `dir` answers for: its own, and
   * those of workspace members below it that have no lockfile of their own.
   */
  const membersOf = (dir: string, name: string, locks: string[]): string[] =>
    [...byDir.entries()]
      .filter(([other, group]) => group.has(name) && lockDirFor(other, locks) === dir)
      .map(([, group]) => group.get(name)!.content);

  for (const [dir, group] of byDir) {
    const get = (name: string) => group.get(name);
    const read = (file: ManifestFile | undefined, parse: (f: ManifestFile) => Dependency[]) => {
      if (!file) return;
      const found = parse(file);
      if (found.length > 0) {
        all.push(...found);
        manifests.push(file.path);
      }
    };

    const packageJsonFile = get("package.json");
    const packageJson = packageJsonFile?.content;
    read(get("package-lock.json") ?? get("npm-shrinkwrap.json"), (f) => parsePackageLock(f.content, f.path, packageJson));
    read(get("pnpm-lock.yaml"), (f) => parsePnpmLock(f.content, f.path, packageJson));
    read(get("yarn.lock"), (f) => parseYarnLock(f.content, f.path, membersOf(dir, "package.json", NPM_LOCKS)));
    read(get("bun.lock"), (f) => parseBunLock(f.content, f.path));

    // A package.json with no lockfile anywhere above it: the versions are
    // ranges. They are still listed, marked unpinned, and the reader is told
    // why nothing could be checked. A workspace member shares the root's
    // lockfile, so it is not flagged.
    if (packageJsonFile && !coveredByNpmLock(dir)) {
      const declared = declaredNpm(packageJson);
      const count = declared.runtime.size + declared.dev.size;
      if (count > 0) {
        for (const [name, range] of declared.runtime) all.push(dep("npm", name, range, packageJsonFile.path, true, "runtime"));
        for (const [name, range] of declared.dev) all.push(dep("npm", name, range, packageJsonFile.path, true, "dev"));
        manifests.push(packageJsonFile.path);
        notes.push(
          `${packageJsonFile.path} has no lockfile, so its ${count} dependencies are version ranges and cannot be checked against advisories. Commit a lockfile.`
        );
      }
    }

    const pyprojects = membersOf(dir, "pyproject.toml", PYTHON_LOCKS);
    read(get("poetry.lock"), (f) => parsePythonLock(f.content, f.path, pyprojects));
    read(get("uv.lock"), (f) => parsePythonLock(f.content, f.path, pyprojects));
    read(get("Pipfile.lock"), (f) => parsePipfileLock(f.content, f.path));
    for (const [name, file] of group) {
      const inRequirementsDir = dir.split("/").pop()?.toLowerCase() === "requirements" && name.endsWith(".txt");
      if (REQUIREMENTS_FILE.test(name) || inRequirementsDir) read(file, (f) => parseRequirements(f.content, f.path));
    }

    read(get("go.mod"), (f) => parseGoMod(f.content, f.path));
    read(get("Cargo.lock"), (f) => parseCargoLock(f.content, f.path, membersOf(dir, "Cargo.toml", ["Cargo.lock"])));
    read(get("Gemfile.lock"), (f) => parseGemfileLock(f.content, f.path));
    read(get("composer.lock"), (f) => parseComposerLock(f.content, f.path, get("composer.json")?.content));
  }

  return { dependencies: dedupe(all), manifests, notes };
}

/** One entry per package version. Direct anywhere is direct; runtime beats dev. */
export function dedupe(dependencies: Dependency[]): Dependency[] {
  const byKey = new Map<string, Dependency>();
  for (const d of dependencies) {
    const key = `${packageKey(d.ecosystem, d.name)}@${d.version}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...d });
      continue;
    }
    existing.direct = existing.direct || d.direct;
    if (d.scope === "runtime") existing.scope = "runtime";
    else if (existing.scope === "unknown") existing.scope = d.scope;
  }
  return [...byKey.values()];
}
