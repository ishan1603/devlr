import type { Metadata } from "next";
import { redirect } from "next/navigation";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Set up" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const me = await getMe();
  if (!me) redirect("/signin");
  if (me.profile.onboarded_at) redirect("/app");

  // Set when the reader has just come back from connecting GitHub. The flow
  // resumes on the step they left from, which was saved before they went.
  const { github } = await searchParams;
  return <OnboardingFlow initial={me} githubOutcome={github} />;
}
