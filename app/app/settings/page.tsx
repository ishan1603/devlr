import type { Metadata } from "next";
import { SettingsPanel } from "@/components/app/forms";
import { Page, PageHeader } from "@/components/ui";
import { appUrl } from "@/lib/delivery/tokens";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const me = (await getMe())!;
  return (
    <Page>
      <PageHeader title="Settings" description="Your account, your feed, and the exit." />
      <SettingsPanel initial={me} feedUrl={`${appUrl()}/feed/${me.profile.feed_token}`} />
    </Page>
  );
}
