import { dependencyKey } from "@/lib/guard/osv";
import { packageKey } from "@/lib/guard/purl";
import { compareVersions, isBreakingUpgrade, newest, pickFix } from "@/lib/guard/versions";
import type { Advisory, Dependency, Ecosystem, Finding } from "@/lib/guard/types";

/**
 * One upgrade per package.
 *
 * A package with twenty advisories does not need twenty fixes. It needs one
 * version to move to. The obvious candidate is the highest "fixed in" among
 * its advisories, but that is only a guess: an advisory can cover several
 * release lines, and the version that fixes one line can sit inside the
 * affected range of another. Newer releases can also carry bugs the installed
 * one never had.
 *
 * So the candidate is put to the same judge that found the problems. OSV is
 * asked about the exact target version. If it comes back clean, the plan is
 * verified and the reader can be told "this clears all of them". If something
 * still applies, the target moves up to that advisory's fix and is checked
 * again, a few times at most. What cannot be cleared is listed, not hidden.
 */

export interface UpgradePlan {
  ecosystem: Ecosystem;
  name: string;
  /** The installed version the plan starts from. */
  from: string;
  /** The version to move to, or null when nothing published fixes any of it. */
  target: string | null;
  /** OSV was asked about `target` and knows of nothing against it. */
  verified: boolean;
  /** The move crosses a major version (or a minor one below 1.0), so it may need code changes. */
  breaking: boolean;
  /** Ids of advisories that still apply at `target`, or all of them when there is no target. */
  remaining: string[];
}

export interface UpgradeSources {
  /** Which advisories apply to these exact versions: dependencyKey -> advisory ids. */
  query: (dependencies: Dependency[]) => Promise<Map<string, string[]>>;
  /** An advisory by any of its ids, or null if it cannot be loaded. */
  advisory: (id: string) => Promise<Advisory | null>;
}

/** Enough to follow a fix across a couple of release lines without chasing forever. */
const MAX_ROUNDS = 3;

const probe = (ecosystem: Ecosystem, name: string, version: string): Dependency => ({
  ecosystem,
  name,
  version,
  pinned: true,
  direct: false,
  scope: "unknown",
});

/**
 * The starting point for one package: the highest fix among its vulnerability
 * findings, not yet confirmed by anyone. `group` is one package's findings,
 * most pressing first, so its first entry is the copy that matters most.
 */
export function draftPlan(group: Finding[]): UpgradePlan {
  const from = group[0].version ?? "";
  const target = newest(group.map((f) => f.fixedIn).filter((v): v is string => Boolean(v)));
  return {
    ecosystem: group[0].ecosystem!,
    name: group[0].package!,
    from,
    target,
    verified: false,
    breaking: target ? isBreakingUpgrade(from, target) : false,
    // An advisory with no fix of its own is not cleared by someone else's.
    remaining: group.filter((f) => !f.fixedIn && f.sourceId).map((f) => f.sourceId!),
  };
}

/** Plans keyed by `ecosystem:name`, for every package with a vulnerability finding. */
export async function planUpgrades(findings: Finding[], sources: UpgradeSources): Promise<Map<string, UpgradePlan>> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.kind !== "vulnerability" || !finding.ecosystem || !finding.package || !finding.version) continue;
    const key = packageKey(finding.ecosystem, finding.package);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  const plans = new Map<string, UpgradePlan>();
  for (const [key, group] of groups) plans.set(key, draftPlan(group));

  let pending = [...plans.entries()].filter(([, plan]) => plan.target !== null);
  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
    const matches = await sources.query(pending.map(([, plan]) => probe(plan.ecosystem, plan.name, plan.target!)));
    const next: typeof pending = [];

    for (const [key, plan] of pending) {
      const ids = matches.get(dependencyKey(probe(plan.ecosystem, plan.name, plan.target!))) ?? [];

      // The same issue can come back under several ids. Resolve each to one
      // advisory and count it once. One that cannot be loaded is kept as
      // unresolved: not knowing is not the same as clean.
      const live = new Map<string, Advisory | null>();
      for (const id of ids) {
        const advisory = await sources.advisory(id);
        if (advisory?.withdrawn) continue;
        live.set(advisory?.id ?? id, advisory);
      }

      if (live.size === 0) {
        plan.verified = true;
        plan.remaining = [];
        continue;
      }

      plan.remaining = [...live.keys()].sort();
      const further = newest(
        [...live.values()]
          .map((advisory) => (advisory ? pickFix(plan.target!, advisory.fixes[key] ?? []) : null))
          .filter((v): v is string => v !== null)
      );
      // Nothing newer fixes what is left: this is as far as an upgrade goes.
      if (!further || compareVersions(further, plan.target!) <= 0) continue;
      // Out of rounds. The plan stays on the last version that was actually
      // checked, with what is known to remain there, instead of ending on a
      // target nobody has asked about.
      if (round === MAX_ROUNDS - 1) continue;

      plan.target = further;
      plan.breaking = isBreakingUpgrade(plan.from, further);
      next.push([key, plan]);
    }
    pending = next;
  }

  return plans;
}
