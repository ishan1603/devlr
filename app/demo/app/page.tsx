import type { Metadata } from "next";
import { HomeView } from "@/components/app/views";
import { DEMO_DELIVERIES, DEMO_ME } from "@/lib/demo";

export const metadata: Metadata = { title: "Home" };

export default function DemoHome() {
  return <HomeView me={DEMO_ME} deliveries={DEMO_DELIVERIES} basePath="/demo/app" />;
}
