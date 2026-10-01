import type { Dependency } from "@/lib/guard/types";

/**
 * The command that fixes a finding.
 *
 * Only commands that are certain to do what they say are offered, and each
 * says which of three things it does, because they are not the same promise:
 *
 *   upgrade   sets the version. After it runs, the package is at the fix.
 *   refresh   re-resolves a nested package within the range its parent
 *             allows. It gets there only if that range reaches the fix.
 *   trace     changes nothing. It shows what pulls the package in, for the
 *             cases where the parent is what has to move.
 *
 * Where a package manager has no single reliable command for the situation,
 * none is returned. A guess that silently does nothing is worse than no
 * command at all.
 */

export type FixKind = "upgrade" | "refresh" | "trace";

export interface Fix {
  command: string;
  kind: FixKind;
}

type Manager =
  | "npm" | "pnpm" | "yarn" | "bun"
  | "pip" | "poetry" | "uv" | "pipenv"
  | "go" | "cargo" | "bundler" | "composer" | "nuget" | "none";

function managerOf(dependency: Pick<Dependency, "ecosystem" | "manifest">): Manager {
  const file = (dependency.manifest ?? "").split("/").pop() ?? "";
  switch (dependency.ecosystem) {
    case "npm":
      if (file === "pnpm-lock.yaml") return "pnpm";
      if (file === "yarn.lock") return "yarn";
      if (file === "bun.lock") return "bun";
      return "npm";
    case "PyPI":
      if (file === "poetry.lock") return "poetry";
      if (file === "uv.lock") return "uv";
      if (file === "Pipfile.lock") return "pipenv";
      return "pip";
    case "Go":
      return "go";
    case "crates.io":
      return "cargo";
    case "RubyGems":
      return "bundler";
    case "Packagist":
      return "composer";
    case "NuGet":
      return "nuget";
    default:
      return "none";
  }
}

/**
 * Shell-quote only when needed, so ordinary names stay readable. Anything with
 * a character some shell treats specially (">" redirects, "^" escapes in
 * cmd.exe) is quoted, because the reader will paste this somewhere.
 */
function arg(value: string): string {
  return /^[\w@./:+=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface FixOptions {
  /**
   * The fix is a breaking release (a new major version). A nested package
   * cannot be refreshed across one, so the parent is what needs finding.
   */
  breaking?: boolean;
}

/**
 * How to move `dependency` to `fixedIn`, or null when there is no command
 * worth printing (unknown package manager, or no fixed version).
 */
export function planFix(
  dependency: Pick<Dependency, "ecosystem" | "name" | "manifest" | "direct">,
  fixedIn: string | null | undefined,
  options: FixOptions = {}
): Fix | null {
  if (!fixedIn) return null;
  const { name, direct } = dependency;
  const version = fixedIn.replace(/^v/, "");
  const upgrade = (command: string): Fix => ({ command, kind: "upgrade" });
  const refresh = (command: string): Fix => ({ command, kind: "refresh" });
  const trace = (command: string): Fix => ({ command, kind: "trace" });

  switch (managerOf(dependency)) {
    case "npm":
      if (direct) return upgrade(`npm install ${arg(`${name}@${version}`)}`);
      // `npm update <name>` re-resolves a nested package, but never past its parent's range.
      return options.breaking ? trace(`npm ls ${arg(name)}`) : refresh(`npm update ${arg(name)}`);
    case "pnpm":
      return direct ? upgrade(`pnpm add ${arg(`${name}@${version}`)}`) : trace(`pnpm why ${arg(name)}`);
    case "yarn":
      return direct ? upgrade(`yarn add ${arg(`${name}@${version}`)}`) : trace(`yarn why ${arg(name)}`);
    case "bun":
      // Nothing in bun reliably moves one nested package, so only direct ones get a command.
      return direct ? upgrade(`bun add ${arg(`${name}@${version}`)}`) : null;
    case "pip":
      // A requirements file has no parents to respect: this sets the floor.
      return upgrade(`pip install ${arg(`${name}>=${version}`)}`);
    case "poetry":
      return direct ? upgrade(`poetry add ${arg(`${name}@^${version}`)}`) : refresh(`poetry update ${arg(name)}`);
    case "uv":
      return direct ? upgrade(`uv add ${arg(`${name}>=${version}`)}`) : refresh(`uv lock --upgrade-package ${arg(name)}`);
    case "pipenv":
      return refresh(`pipenv update ${arg(name)}`);
    case "go":
      // Minimal version selection: asking for a version raises it, direct or not.
      return upgrade(`go get ${arg(`${name}@v${version}`)}`);
    case "cargo":
      // Cargo will only pick a version every dependent's requirement accepts.
      return refresh(`cargo update -p ${arg(name)} --precise ${arg(version)}`);
    case "bundler":
      return refresh(`bundle update ${arg(name)} --conservative`);
    case "composer":
      return direct
        ? upgrade(`composer require ${arg(`${name}:^${version}`)}`)
        : refresh(`composer update ${arg(name)} --with-dependencies`);
    case "nuget":
      return direct ? upgrade(`dotnet add package ${arg(name)} --version ${arg(version)}`) : null;
    default:
      return null;
  }
}

/** Just the command, for callers that do not need to know its kind. */
export function fixCommand(
  dependency: Pick<Dependency, "ecosystem" | "name" | "manifest" | "direct">,
  fixedIn: string | null | undefined,
  options: FixOptions = {}
): string | null {
  return planFix(dependency, fixedIn, options)?.command ?? null;
}
