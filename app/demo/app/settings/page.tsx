import type { Metadata } from "next";
import { SettingsPanel } from "@/components/app/forms";
import { Page, PageHeader } from "@/components/ui";
import { DEMO_ME } from "@/lib/demo";

export const metadata: Metadata = { title: "Settings" };

export default function DemoSettings() {
  return (
    <Page>
      <PageHeader title="Settings" description="Your account, your feed, and the exit." />
      <SettingsPanel
        initial={DEMO_ME}
        feedUrl={`https://devlr.vercel.app/feed/${DEMO_ME.profile.feed_token}`}
      />
    </Page>
  );
}
