/**
 * Ordering versions, across ecosystems, well enough to answer one question:
 * of the versions that fix this, which is the smallest one newer than what is
 * installed?
 *
 * This is not used to decide whether something is vulnerable. OSV does that
 * with each ecosystem's own rules. It only picks which fix to suggest, so a
 * simple, predictable comparison is the right tool: numeric segments compared
 * as numbers, a pre-release sorting before its release, and a post-release
 * after it.
 */

interface Parsed {
  numbers: number[];
  /** Whatever follows the numbers ("rc.1", "beta", "post1"), or "" for a plain release. */
  pre: string;
}

function parse(version: string): Parsed {
  const clean = version.trim().replace(/^[vV=]+/, "").split("+")[0];
  // The release part is the leading run of dot-separated numbers.
  const match = clean.match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!match) return { numbers: [], pre: clean };
  return {
    numbers: match[1].split(".").map(Number),
    pre: match[2].replace(/^[-._]/, ""),
  };
}

/**
 * Where a suffix puts a version relative to the plain release: before it for
 * a pre-release ("rc.1", "beta"), after it for Python's post-releases
 * ("1.0.post1" is a re-release of 1.0, and newer).
 */
const suffixRank = (suffix: string) => (!suffix ? 0 : /^post/i.test(suffix) ? 1 : -1);

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  const rank = suffixRank(a) - suffixRank(b);
  if (rank !== 0) return rank < 0 ? -1 : 1;

  const partsA = a.split(/[.-]/);
  const partsB = b.split(/[.-]/);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== null) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (ny !== null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Negative if a is older than b, positive if newer, 0 if the same. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.numbers.length, pb.numbers.length); i++) {
    const x = pa.numbers[i] ?? 0;
    const y = pb.numbers[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

const major = (version: string) => parse(version).numbers[0];

/**
 * Would moving between these two versions cross a line where breaking changes
 * are allowed? That is a new major version, or, below 1.0, a new minor one,
 * which is how semver treats releases that have not promised stability yet.
 */
export function isBreakingUpgrade(from: string, to: string): boolean {
  const a = parse(from).numbers;
  const b = parse(to).numbers;
  if (a.length === 0 || b.length === 0) return false;
  if (a[0] !== b[0]) return true;
  return a[0] === 0 && (a[1] ?? 0) !== (b[1] ?? 0);
}

/** The newest of a list of versions, or null for an empty list. */
export function newest(versions: string[]): string | null {
  return versions.length === 0 ? null : versions.slice().sort(compareVersions)[versions.length - 1];
}

/**
 * The fix to suggest for an installed version.
 *
 * Prefers the smallest fix on the same major version, because that is the
 * upgrade least likely to break anything. Only when the installed major line
 * has no fix does it reach for the smallest fix on a later one. Returns null
 * when nothing newer than the installed version fixes it.
 */
export function pickFix(installed: string, fixes: string[]): string | null {
  const newer = [...new Set(fixes)]
    .filter((fix) => compareVersions(fix, installed) > 0)
    .sort(compareVersions);
  if (newer.length === 0) return null;
  return newer.find((fix) => major(fix) === major(installed)) ?? newer[0];
}
