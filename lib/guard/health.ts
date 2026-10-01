import type { FindingKind, Priority } from "@/lib/guard/types";

/**
 * A repository's dependency health as one number.
 *
 * It is counted per package, not per advisory. A framework three releases
 * behind can match twenty advisories, and it is still one upgrade: scoring
 * each advisory would make the number say more about how a database chose to
 * split its records than about the repo.
 *
 * The score starts at 100 and loses points for each package that needs
 * attention, weighted by how pressing that is. Two properties are deliberate:
 *
 *   - Low-priority entries are capped as a group. Thirty informational notes
 *     should not score worse than one actively exploited vulnerability.
 *   - Anything urgent caps the score regardless of the rest. A repo with a
 *     known malicious package is not "B" because everything else is tidy.
 */

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface Health {
  score: number;
  grade: Grade;
  /** Packages (and runtimes) needing attention, by how pressing. */
  counts: { urgent: number; high: number; medium: number; low: number };
}

const PENALTY = { urgent: 30, high: 14, medium: 6, low: 2 } as const;
/** The most that everything at one priority can cost together. */
const GROUP_CAP = { urgent: 100, high: 60, medium: 30, low: 10 } as const;

export function gradeFor(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

/** `entries` is the per-package rollup: one item per thing to fix. */
export function healthOf(entries: { priority: Priority; kind: FindingKind }[]): Health {
  const counts = { urgent: 0, high: 0, medium: 0, low: 0 };
  for (const entry of entries) counts[entry.priority]++;

  let score = 100;
  for (const priority of ["urgent", "high", "medium", "low"] as const) {
    score -= Math.min(GROUP_CAP[priority], counts[priority] * PENALTY[priority]);
  }
  score = Math.max(0, score);

  // Malware, or anything urgent, sets a ceiling no amount of tidiness lifts.
  if (entries.some((entry) => entry.kind === "malicious")) score = Math.min(score, 20);
  else if (counts.urgent > 0) score = Math.min(score, 55);

  return { score, grade: gradeFor(score), counts };
}
