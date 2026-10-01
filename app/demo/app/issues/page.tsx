import type { Metadata } from "next";
import { IssuesView } from "@/components/app/views";
import { DEMO_DELIVERIES, DEMO_ME } from "@/lib/demo";

export const metadata: Metadata = { title: "Issues" };

export default function DemoIssues() {
  return <IssuesView me={DEMO_ME} deliveries={DEMO_DELIVERIES} />;
}
