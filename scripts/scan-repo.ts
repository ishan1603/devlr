import { resolve } from "node:path";

import { parseRepoRef } from "@/lib/guard/github";
import { readLocalRepo } from "@/lib/guard/local";
import { analyzeInventory, scanRepository, type Analysis } from "@/lib/guard/scan";
import type { PackageReport } from "@/lib/guard/rollup";
import type { DetectedRuntime } from "@/lib/guard/runtimes";
import type { Finding, Inventory } from "@/lib/guard/types";

/**
 * Scan a repository's dependencies from the command line.
 *
 *   npm run guard:scan -- vercel/ms
 *   npm run guard:scan -- https://github.com/owner/repo --json
 *   npm run guard:scan -- owner/repo@some-branch --all
 *   npm run guard:scan -- --local            this checkout, pushed or not
 *   npm run guard:scan -- --local ../other
 *
 * Works on any public repository with no setup. Set GITHUB_TOKEN to raise
 * GitHub's limit from 60 requests an hour, or to read a private repository
 * your token can see. Nothing is stored; this only reads and prints.
 */

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showAll = args.includes("--all");
const local = args.includes("--local");
const target = args.find((a) => !a.startsWith("--"));

const repo = !local && target ? parseRepoRef(target) : null;
if (!local && !repo) {
  console.error("usage: npm run guard:scan -- <owner/repo | github url | --local [dir]> [--json] [--all]");
  process.exit(1);
}

const LABEL = { urgent: "URGENT", high: "HIGH  ", medium: "MEDIUM", low: "LOW   " } as const;
const PAD = "          ";

function advisoryLine(finding: Finding): string {
  const parts = [finding.sourceId ?? finding.kind];
  const cve = finding.aliases?.find((a) => a.startsWith("CVE-"));
  if (cve) parts.push(cve);
  if (finding.severity && finding.severity !== "unknown") {
    parts.push(finding.cvss != null ? `${finding.severity} ${finding.cvss.toFixed(1)}` : finding.severity);
  }
  if (finding.kev) parts.push("KEV");
  if (finding.epss != null && finding.epss >= 0.01) parts.push(`EPSS ${(finding.epss * 100).toFixed(1)}%`);
  parts.push(finding.fixedIn ? `fixed in ${finding.fixedIn}` : "no fix");
  return `${PAD}  - ${parts.join("  ")}\n${PAD}    ${finding.summary}`;
}

function describe(entry: PackageReport): string[] {
  const lines = [`  ${LABEL[entry.priority]}  ${entry.title}`];

  const facts: string[] = [];
  if (entry.package) {
    facts.push(`${entry.direct ? "direct" : "transitive"}${entry.scope === "dev" ? ", dev only" : ""}`);
    if (entry.versions.length > 1) facts.push(`installed: ${entry.versions.join(", ")}`);
    if (entry.manifest) facts.push(entry.manifest);
  }
  if (entry.kev) facts.push("exploited in the wild (CISA KEV)");
  if (facts.length) lines.push(`${PAD}${facts.join("  |  ")}`);

  lines.push(`${PAD}${entry.action}`);
  if (entry.command) lines.push(`${PAD}$ ${entry.command}`);
  if (entry.url) lines.push(`${PAD}${entry.url}`);
  if (showAll && entry.findings.length > 1) for (const finding of entry.findings) lines.push(advisoryLine(finding));
  return lines;
}

function print(heading: string, inventory: Inventory, runtimes: DetectedRuntime[], analysis: Analysis, started: number) {
  const { stats, health, packages, findings } = analysis;
  const source =
    inventory.method === "sbom" ? "GitHub's dependency graph" : inventory.manifests.join(", ") || "no manifests";

  console.log(`\n${heading}`);
  console.log(
    `${stats.dependencies} dependencies (${stats.direct} direct, ${stats.pinned} with exact versions) ` +
      `across ${stats.ecosystems.join(", ") || "no ecosystems"}, read from ${source}`
  );
  if (runtimes.length) {
    console.log(`Runtimes: ${runtimes.map((r) => `${r.product} ${r.cycle} (${r.source})`).join(", ")}`);
  }
  console.log(
    `\nHealth ${health.score}/100 (${health.grade})   ` +
      `${health.counts.urgent} urgent, ${health.counts.high} high, ${health.counts.medium} medium, ${health.counts.low} low` +
      `   (${packages.length} to fix, from ${findings.length} ${findings.length === 1 ? "finding" : "findings"})\n`
  );

  const visible = showAll ? packages : packages.slice(0, 12);
  for (const entry of visible) console.log(describe(entry).join("\n") + "\n");
  if (packages.length > visible.length) {
    console.log(`  ... and ${packages.length - visible.length} more. Run with --all to see everything.\n`);
  }
  if (packages.length === 0) console.log("  Nothing found.\n");

  for (const note of inventory.notes) console.log(`note: ${note}`);
  for (const warning of analysis.warnings) console.log(`warning: ${warning}`);
  console.log(`\nScanned in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

async function main() {
  const started = Date.now();

  if (local) {
    const root = resolve(target ?? ".");
    const { inventory, runtimes } = await readLocalRepo(root);
    const analysis = await analyzeInventory(inventory, runtimes);
    if (asJson) console.log(JSON.stringify({ root, inventory, runtimes, ...analysis, deprecations: undefined }, null, 2));
    else print(root, inventory, runtimes, analysis, started);
    return;
  }

  const result = await scanRepository(repo!);
  if (asJson) {
    console.log(JSON.stringify({ ...result, deprecations: undefined }, null, 2));
    return;
  }
  print(
    `${result.repo.fullName} @ ${result.ref}${result.repo.archived ? "  (archived)" : ""}`,
    result.inventory,
    result.runtimes,
    result,
    started
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
