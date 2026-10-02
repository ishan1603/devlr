import type { Metadata } from "next";
import { HomeView } from "@/components/app/views";
import { DEMO_DELIVERIES, DEMO_ME } from "@/lib/demo";
import { DEMO_REPOS } from "@/lib/demo-repos";

export const metadata: Metadata = { title: "Home" };

export default function DemoHome() {
  return (
    <HomeView
      me={DEMO_ME}
      deliveries={DEMO_DELIVERIES}
      repos={DEMO_REPOS.filter((repo) => repo.watching)}
      basePath="/demo/app"
      now={new Date("2026-10-01T08:00:00Z")}
    />
  );
}
