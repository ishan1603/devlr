import type { Metadata } from "next";
import { ReposView } from "@/components/app/repos";
import { createClient } from "@/lib/server";
import { githubAppConfigured } from "@/lib/github/app";
import { MAX_WATCHED_REPOS } from "@/lib/guard/repos";
import { REPO_LIST_COLUMNS, type GuardAccount, type RepoSummary } from "@/lib/guard/view";

export const metadata: Metadata = { title: "Repos" };

export default async function ReposPage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const { github } = await searchParams;

  // Row level security scopes both queries to the signed-in user's own rows.
  const supabase = await createClient();
  const [{ data: repos }, { data: installations }] = await Promise.all([
    supabase.from("repositories").select(REPO_LIST_COLUMNS).order("full_name"),
    supabase
      .from("github_installations")
      .select("installation_id, account_login, account_type, suspended_at")
      .order("account_login"),
  ]);

  const account: GuardAccount = {
    githubConfigured: githubAppConfigured(),
    accounts: (installations ?? []).map((i) => ({
      installationId: Number(i.installation_id),
      login: i.account_login as string,
      type: i.account_type as "User" | "Organization",
      suspended: Boolean(i.suspended_at),
    })),
    limit: MAX_WATCHED_REPOS,
  };

  return <ReposView repos={(repos ?? []) as unknown as RepoSummary[]} account={account} outcome={github} />;
}
