import type { Metadata } from "next";
import { TopicsForm } from "@/components/app/forms";
import { Page, PageHeader } from "@/components/ui";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Topics" };

export default async function TopicsPage() {
  const me = (await getMe())!;
  return (
    <Page>
      <PageHeader
        title="Topics"
        description="What Devlr reads on your behalf. Changes apply from your next issue."
      />
      <TopicsForm initial={me} />
    </Page>
  );
}
