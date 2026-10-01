import type { Metadata } from "next";
import { TopicsForm } from "@/components/app/forms";
import { Page, PageHeader } from "@/components/ui";
import { DEMO_ME } from "@/lib/demo";

export const metadata: Metadata = { title: "Topics" };

export default function DemoTopics() {
  return (
    <Page>
      <PageHeader
        title="Topics"
        description="What Devlr reads on your behalf. Changes apply from your next issue."
      />
      <TopicsForm initial={DEMO_ME} />
    </Page>
  );
}
