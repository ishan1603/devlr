import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { EVENTS, inngest, type GuardScanEvent } from "@/lib/inngest/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A scan reads a dozen files from GitHub. Once a minute per repo is plenty. */
const MIN_INTERVAL_MS = 60_000;

/**
 * "Scan now."
 *
 * Only queues it. A scan talks to GitHub and four other services and can take
 * several seconds, so it runs as a background job and the page polls for the
 * result.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return NextResponse.json({ error: "Repository not found." }, { status: 404 });

  // Read through the reader's own session, so this can only find their repo.
  const { data: repo } = await supabase
    .from("repositories")
    .select("id, watching, scanned_at, scan_status")
    .eq("id", id)
    .maybeSingle();
  if (!repo) return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  if (!repo.watching) return NextResponse.json({ error: "Start watching this repository to scan it." }, { status: 409 });

  const last = repo.scanned_at ? Date.parse(repo.scanned_at as string) : 0;
  if (repo.scan_status !== "failed" && Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "This was scanned a moment ago. Give it a minute." }, { status: 429 });
  }

  try {
    await inngest.send({ name: EVENTS.guardScan, data: { repoId: id, force: true } satisfies GuardScanEvent });
  } catch (err) {
    console.error("repos: could not queue the scan:", err);
    return NextResponse.json({ error: "Could not queue the scan. Is the Inngest dev server running?" }, { status: 503 });
  }

  // Shown as "scanning" until the job writes its result.
  await createAdminClient()
    .from("repositories")
    .update({ scan_status: "pending", scan_error: null })
    .eq("id", id)
    .eq("user_id", user.id);

  return NextResponse.json({ queued: true });
}
