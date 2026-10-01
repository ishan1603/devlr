import AppShell from "@/components/app/AppShell";
import { DEMO_ME } from "@/lib/demo";

export default function DemoAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell email={DEMO_ME.profile.email} paused={DEMO_ME.profile.is_paused} basePath="/demo/app">
      {children}
    </AppShell>
  );
}
