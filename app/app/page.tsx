import type { Metadata } from "next";
import { HomeView, type DeliveryRow } from "@/components/app/views";
import { createClient } from "@/lib/server";
import { REPO_LIST_COLUMNS, type RepoSummary } from "@/lib/guard/view";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  // The layout has already redirected anyone without a profile.
  const me = (await getMe())!;

  // Row level security scopes this to the signed-in user's own rows.
  const supabase = await createClient();
  const [{ data }, { data: repos }] = await Promise.all([
    supabase
      .from("deliveries")
      .select("id, status, subject, web_token, created_at, sent_at")
      .order("created_at", { ascending: false })
      .limit(5),
    // Worst first: the one that needs opening is at the top. A repo with no
    // score yet sorts last.
    supabase
      .from("repositories")
      .select(REPO_LIST_COLUMNS)
      .eq("watching", true)
      .order("health_score", { ascending: true, nullsFirst: false })
      .limit(4),
  ]);

  return (
    <HomeView
      me={me}
      deliveries={(data ?? []) as DeliveryRow[]}
      repos={(repos ?? []) as unknown as RepoSummary[]}
    />
  );
}
