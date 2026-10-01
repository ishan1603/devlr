import type { Severity } from "@/lib/guard/types";

/**
 * CVSS v3 base score, computed from the vector string.
 *
 * OSV publishes the vector ("CVSS:3.1/AV:N/AC:L/...") but not the number, and
 * a reader wants the number. This is the arithmetic from the FIRST
 * specification (section 7.1), nothing more: no judgement is involved, and the
 * tests pin it against published scores.
 *
 * CVSS v4 is deliberately not computed. Its score comes from a 270-entry
 * lookup table rather than a formula, and where a v4 vector is all there is,
 * the advisory database's own severity label is used instead.
 */

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
/** Privileges Required weighs differently when the scope changes. */
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };

/** The specification's own rounding: up to one decimal, with float noise removed first. */
function roundUp(value: number): number {
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

/** Base score for a CVSS 3.0 or 3.1 vector, or null if it is not one. */
export function cvss3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;

  const metrics: Record<string, string> = {};
  for (const part of vector.split("/").slice(1)) {
    const [key, value] = part.split(":");
    if (key && value) metrics[key] = value;
  }

  const changed = metrics.S === "C";
  const av = AV[metrics.AV];
  const ac = AC[metrics.AC];
  const ui = UI[metrics.UI];
  const pr = (changed ? PR_CHANGED : PR_UNCHANGED)[metrics.PR];
  const c = CIA[metrics.C];
  const i = CIA[metrics.I];
  const a = CIA[metrics.A];

  if ([av, ac, ui, pr, c, i, a].some((v) => v === undefined) || !["U", "C"].includes(metrics.S)) {
    return null;
  }

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  return changed
    ? roundUp(Math.min(1.08 * (impact + exploitability), 10))
    : roundUp(Math.min(impact + exploitability, 10));
}

/** The qualitative bands from the specification. */
export function severityFromScore(score: number | null): Severity {
  if (score === null) return "unknown";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  if (score > 0) return "low";
  return "unknown";
}

/** Advisory databases label severity in words, with a few spellings. */
export function severityFromLabel(label: unknown): Severity {
  switch (String(label ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "moderate";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}
