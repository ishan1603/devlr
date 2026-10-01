import type { Metadata } from "next";
import { ScheduleForm } from "@/components/app/forms";
import { Page, PageHeader } from "@/components/ui";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Schedule" };

export default async function SchedulePage() {
  const me = (await getMe())!;
  return (
    <Page>
      <PageHeader title="Schedule" description="Which modules you get, how often, and when they arrive." />
      <ScheduleForm initial={me} />
    </Page>
  );
}
