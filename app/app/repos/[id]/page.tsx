import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RepoDetailView } from "@/components/app/repos";
import { createClient } from "@/lib/server";
import { appUrl } from "@/lib/delivery/tokens";
import { REPO_DETAIL_COLUMNS, type RepoDetail } from "@/lib/guard/view";

export const metadata: Metadata = { title: "Repo" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  // Row level security makes someone else's repository indistinguishable from
  // one that does not exist, which is the right answer to give.
  const supabase = await createClient();
  const { data } = await supabase.from("repositories").select(REPO_DETAIL_COLUMNS).eq("id", id).maybeSingle();
  if (!data) notFound();

  const repo = data as unknown as RepoDetail;
  return <RepoDetailView repo={{ ...repo, notes: repo.notes ?? [] }} appUrl={appUrl()} />;
}
