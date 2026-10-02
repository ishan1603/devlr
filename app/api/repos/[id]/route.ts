import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/server";
import { removeRepo, setWatching } from "@/lib/guard/repos";
import { REPO_DETAIL_COLUMNS, type RepoDetail } from "@/lib/guard/view";
import { EVENTS, inngest, type GuardScanEvent } from "@/lib/inngest/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ id: string }> };

async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** One repository with its full report. Row level security hides anyone else's. */
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const { supabase, user } = await signedIn();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Repository not found." }, { status: 404 });

  const { data } = await supabase.from("repositories").select(REPO_DETAIL_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  return NextResponse.json({ repo: data as unknown as RepoDetail });
}

const Patch = z.object({ watching: z.boolean() });

/** Start or stop watching. */
export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const { user } = await signedIn();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Repository not found." }, { status: 404 });

  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const result = await setWatching(user.id, id, parsed.data.watching);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  if (parsed.data.watching) {
    try {
      await inngest.send({ name: EVENTS.guardScan, data: { repoId: id } satisfies GuardScanEvent });
    } catch (err) {
      console.error("repos: could not queue a scan:", err);
    }
  }
  return NextResponse.json({ ok: true });
}

/** Remove a repository that was added by name, with everything stored about it. */
export async function DELETE(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const { user } = await signedIn();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Repository not found." }, { status: 404 });

  const result = await removeRepo(user.id, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
