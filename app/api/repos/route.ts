import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/server";
import { githubAppConfigured } from "@/lib/github/app";
import { MAX_WATCHED_REPOS, addPublicRepo } from "@/lib/guard/repos";
import { REPO_LIST_COLUMNS, type GuardAccount, type RepoSummary } from "@/lib/guard/view";
import { EVENTS, inngest, type GuardScanEvent } from "@/lib/inngest/client";

/** The reader's repositories and GitHub accounts. Row level security scopes both. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const [{ data: repos, error }, { data: installations }] = await Promise.all([
    supabase.from("repositories").select(REPO_LIST_COLUMNS).order("full_name"),
    supabase.from("github_installations").select("installation_id, account_login, account_type, suspended_at").order("account_login"),
  ]);
  if (error) return NextResponse.json({ error: "Could not load your repositories." }, { status: 500 });

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
  return NextResponse.json({ repos: (repos ?? []) as unknown as RepoSummary[], account });
}

const AddRepo = z.object({ repo: z.string().trim().min(3).max(200) });

/** Watch a public repository by name. Private ones come through the GitHub App. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = AddRepo.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give a repository as owner/name." }, { status: 400 });

  const result = await addPublicRepo(user.id, parsed.data.repo);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  try {
    await inngest.send({ name: EVENTS.guardScan, data: { repoId: result.value.id } satisfies GuardScanEvent });
  } catch (err) {
    // The repository is saved either way. The sweep will pick it up.
    console.error("repos: could not queue the first scan:", err);
  }
  return NextResponse.json({ repo: result.value }, { status: 201 });
}
