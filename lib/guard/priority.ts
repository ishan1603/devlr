import type { FindingKind, Priority, Scope, Severity } from "@/lib/guard/types";

/**
 * How much a finding should interrupt someone.
 *
 * Severity alone is a poor guide. A critical bug in a dev-only tool that is
 * never deployed matters less than a moderate one under active exploitation
 * in something that faces the internet. So the score combines what the bug is
 * (severity), whether anyone is using it (KEV, EPSS), and whether it is on
 * this repo's attack surface (direct, runtime).
 *
 * Pure and deterministic. The same inputs always give the same answer, and the
 * tests pin the orderings that matter.
 */

export interface PriorityInput {
  kind: FindingKind;
  severity?: Severity;
  /** In CISA's Known Exploited Vulnerabilities catalog. */
  kev?: boolean;
  /** EPSS probability, 0 to 1. */
  epss?: number | null;
  direct?: boolean;
  scope?: Scope;
  /** A fixed version exists, so there is something the reader can do. */
  hasFix?: boolean;
  /** For end-of-life findings: days until the date (negative once passed). */
  daysLeft?: number;
}

const SEVERITY_BASE: Record<Severity, number> = {
  critical: 80,
  high: 62,
  moderate: 40,
  low: 20,
  // No severity published. Treated as just under moderate rather than ignored.
  unknown: 35,
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function prioritize(input: PriorityInput): { priority: Priority; score: number } {
  switch (input.kind) {
    case "malicious":
      // Not a flaw to weigh: the package is the attack. Always the top.
      return { priority: "urgent", score: 100 };

    case "vulnerability": {
      const severity = input.severity ?? "unknown";
      const dev = input.scope === "dev";
      let score = SEVERITY_BASE[severity];

      if (input.kev) score += 25;
      const epss = input.epss ?? 0;
      if (epss >= 0.5) score += 15;
      else if (epss >= 0.1) score += 8;
      else if (epss >= 0.01) score += 3;

      if (input.direct) score += 6;
      // Dev dependencies do not ship. Still worth fixing, rarely worth a page.
      if (dev) score -= 15;
      // Nothing to upgrade to: worth knowing, but there is no action to take yet.
      if (input.hasFix === false) score -= 5;

      score = clamp(score);
      // Urgent means "sent on its own, now". Reserved for things being
      // exploited, and for critical bugs in shipped code that can be fixed today.
      const urgent = (input.kev && !dev) || (severity === "critical" && !dev && input.hasFix !== false);
      const priority: Priority = urgent ? "urgent" : score >= 60 ? "high" : score >= 35 ? "medium" : "low";
      return { priority, score };
    }

    case "eol": {
      const days = input.daysLeft ?? 0;
      if (days <= 0) return { priority: "high", score: 66 };
      if (days <= 30) return { priority: "high", score: 60 };
      return { priority: "medium", score: 40 };
    }

    case "deprecated":
      return input.scope === "dev" ? { priority: "low", score: 15 } : { priority: "medium", score: 36 };

    case "unresolved":
      return { priority: "low", score: 22 };
  }
}

const ORDER: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Most pressing first; ties broken by score, then by name for a stable order. */
export function comparePriority(
  a: { priority: Priority; score: number; key: string },
  b: { priority: Priority; score: number; key: string }
): number {
  return ORDER[a.priority] - ORDER[b.priority] || b.score - a.score || a.key.localeCompare(b.key);
}
