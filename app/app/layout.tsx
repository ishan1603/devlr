import { redirect } from "next/navigation";
import AppShell from "@/components/app/AppShell";
import { getMe } from "@/lib/profile";

/**
 * Everything under /app needs a signed-in, set-up user. Checked here once, on
 * the server, so no page below has to handle "not signed in" or "not
 * onboarded" and nothing flashes before a client-side redirect.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/signin");
  if (!me.profile.onboarded_at) redirect("/onboarding");

  return (
    <AppShell email={me.profile.email} paused={me.profile.is_paused}>
      {children}
    </AppShell>
  );
}
