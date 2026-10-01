import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DemoApi from "@/components/demo/DemoApi";
import { demoEnabled } from "@/lib/demo";

export const metadata: Metadata = {
  title: { default: "Demo", template: "%s | Devlr demo" },
  robots: { index: false, follow: false },
};

/**
 * Gate for the whole /demo area. See lib/demo.ts for what it is and why.
 */
export default function DemoLayout({ children }: { children: React.ReactNode }) {
  if (!demoEnabled()) notFound();

  return (
    <>
      <DemoApi />
      {children}
    </>
  );
}
