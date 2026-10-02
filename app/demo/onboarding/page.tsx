import type { Metadata } from "next";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import { DEMO_ME_NEW } from "@/lib/demo";

export const metadata: Metadata = { title: "Onboarding" };

export default function DemoOnboarding() {
  return <OnboardingFlow initial={DEMO_ME_NEW} doneHref="/demo/app" githubConnectHref={null} />;
}
