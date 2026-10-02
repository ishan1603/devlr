import type { Metadata } from "next";
import { RepoDetailView } from "@/components/app/repos";
import { DEMO_REPO_DETAIL } from "@/lib/demo-repos";
import { renderBadge } from "@/lib/guard/badge";

export const metadata: Metadata = { title: "Repo" };

const NOW = new Date("2026-10-01T08:00:00Z");

/** Every id shows the same report: the demo has one repository worth opening. */
export default function DemoRepo() {
  const repo = DEMO_REPO_DETAIL;
  const badge = renderBadge({ grade: repo.health_grade, score: repo.health_score });

  return (
    <RepoDetailView
      repo={repo}
      basePath="/demo/app"
      appUrl="https://devlr.example"
      badgeSrc={`data:image/svg+xml;utf8,${encodeURIComponent(badge)}`}
      now={NOW}
    />
  );
}
