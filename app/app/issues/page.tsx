import type { Metadata } from "next";
import { IssuesView, type DeliveryRow } from "@/components/app/views";
import { createClient } from "@/lib/server";
import { getMe } from "@/lib/profile";

export const metadata: Metadata = { title: "Issues" };

export default async function IssuesPage() {
  const me = (await getMe())!;

  // Row level security scopes this to the signed-in user's own rows.
  const supabase = await createClient();
  const { data } = await supabase
    .from("deliveries")
    .select("id, status, subject, preheader, modules, web_token, created_at, sent_at, error")
    .order("created_at", { ascending: false })
    .limit(60);

  return <IssuesView me={me} deliveries={(data ?? []) as DeliveryRow[]} />;
}
