import type { Metadata } from "next";
import { ScheduleForm } from "@/components/app/forms";
import { Page, PageHeader } from "@/components/ui";
import { DEMO_ME } from "@/lib/demo";

export const metadata: Metadata = { title: "Schedule" };

export default function DemoSchedule() {
  return (
    <Page>
      <PageHeader title="Schedule" description="Which modules you get, how often, and when they arrive." />
      <ScheduleForm initial={DEMO_ME} />
    </Page>
  );
}
