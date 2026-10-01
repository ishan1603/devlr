import type { Metadata } from "next";
import { redirect } from "next/navigation";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Set up" };

export default async function OnboardingPage() {
  const me = await getMe();
  if (!me) redirect("/signin");
  if (me.profile.onboarded_at) redirect("/app");

  return <OnboardingFlow initial={me} />;
}
