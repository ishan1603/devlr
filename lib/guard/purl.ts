import type { Ecosystem } from "@/lib/guard/types";

/**
 * Package URLs ("purl") are how an SBOM names a dependency:
 *
 *   pkg:npm/%40scope/name@1.2.3
 *   pkg:golang/github.com/foo/bar@v1.4.0
 *   pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1
 *
 * Each ecosystem folds namespace and name together differently, and OSV wants
 * the name spelled the way that ecosystem's registry spells it. Getting this
 * wrong does not raise an error: the lookup just finds nothing, and a
 * vulnerable package is reported as clean. So it is spelled out per type.
 */

const TYPES: Record<string, Ecosystem> = {
  npm: "npm",
  pypi: "PyPI",
  golang: "Go",
  cargo: "crates.io",
  maven: "Maven",
  gem: "RubyGems",
  nuget: "NuGet",
  composer: "Packagist",
  pub: "Pub",
  hex: "Hex",
  githubactions: "GitHub Actions",
};

export interface ParsedPurl {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** PEP 503: PyPI treats runs of "-", "_" and "." as the same separator. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Parse a purl, or return null for a type we do not check (or a malformed one). */
export function parsePurl(purl: string): ParsedPurl | null {
  if (!purl.startsWith("pkg:")) return null;

  // Qualifiers and subpath say how to fetch the package, not which one it is.
  const core = purl.slice(4).split("#")[0].split("?")[0];
  const slash = core.indexOf("/");
  if (slash === -1) return null;

  const type = core.slice(0, slash).toLowerCase();
  const ecosystem = TYPES[type];
  if (!ecosystem) return null;

  const rest = core.slice(slash + 1);
  // The version follows the last "@". A scoped npm name is percent-encoded
  // ("%40scope"), so an unencoded "@" can only be the version separator, but
  // some tools emit it raw: a leading "@" is therefore never the separator.
  const at = rest.lastIndexOf("@");
  const hasVersion = at > 0;
  const path = decode(hasVersion ? rest.slice(0, at) : rest).replace(/^\/+|\/+$/g, "");
  const version = hasVersion ? decode(rest.slice(at + 1)) : "";
  if (!path) return null;

  const segments = path.split("/");
  let name: string;

  switch (type) {
    case "maven":
      // group:artifact
      if (segments.length < 2) return null;
      name = `${segments.slice(0, -1).join(".")}:${segments[segments.length - 1]}`;
      break;
    case "pypi":
      name = normalizePypiName(segments[segments.length - 1]);
      break;
    case "npm":
      // "@scope/name" stays as written; npm names are case-sensitive in old
      // packages, so nothing is lowercased.
      name = path;
      break;
    case "nuget":
    case "gem":
    case "cargo":
    case "pub":
    case "hex":
      name = segments[segments.length - 1];
      break;
    default:
      // golang, composer, githubactions: the whole path is the name.
      name = path;
  }

  return { ecosystem, name, version };
}

/**
 * Is this a resolved version, or a range that could mean several?
 *
 * "1.2.3", "v1.4.0", "2.0.0-rc.1" and Go's pseudo-versions are exact. Anything
 * with an operator, a wildcard or a space is a constraint.
 */
export function isPinned(version: string): boolean {
  if (!version) return false;
  if (/[\^~><=*|,\s]/.test(version)) return false;
  if (/(^|\.)x(\.|$)/i.test(version)) return false;
  return /^v?\d+(\.\d+)*([-+.][0-9A-Za-z.+-]*)?$/.test(version);
}

/** Key used to index advisories and fixes by package. */
export function packageKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${ecosystem === "PyPI" ? normalizePypiName(name) : name}`;
}
