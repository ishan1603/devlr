import type { Metadata } from "next";
import { ReposView } from "@/components/app/repos";
import { DEMO_ACCOUNT, DEMO_REPOS } from "@/lib/demo-repos";

export const metadata: Metadata = { title: "Repos" };

/** A fixed "now", so "scanned 2 hours ago" reads the same on every render. */
const NOW = new Date("2026-10-01T08:00:00Z");

export default function DemoRepos() {
  return <ReposView repos={DEMO_REPOS} account={DEMO_ACCOUNT} basePath="/demo/app" connectHref={null} now={NOW} />;
}
