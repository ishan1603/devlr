import type { Metadata } from "next";
import { HomeView, type DeliveryRow } from "@/components/app/views";
import { createClient } from "@/lib/server";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Home" };

export default async function HomePage() {
  // The layout has already redirected anyone without a profile.
  const me = (await getMe())!;

  // Row level security scopes this to the signed-in user's own rows.
  const supabase = await createClient();
  const { data } = await supabase
    .from("deliveries")
    .select("id, status, subject, web_token, created_at, sent_at")
    .order("created_at", { ascending: false })
    .limit(5);

  return <HomeView me={me} deliveries={(data ?? []) as DeliveryRow[]} />;
}
