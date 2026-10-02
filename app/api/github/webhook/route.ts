import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { githubAppConfig, verifyWebhook } from "@/lib/github/app";
import { isDefaultBranchPush, touchesDependencies, type PushPayload } from "@/lib/github/webhook";
import { EVENTS, inngest, type GuardScanEvent } from "@/lib/inngest/client";

/**
 * Events from GitHub.
 *
 * Three matter. A push to a default branch that touched a manifest means the
 * stored dependency list is out of date. Removing a repository from the
 * installation, or the installation itself, means Devlr no longer has any
 * business holding what it knows about that code, so it is deleted.
 *
 * The signature is checked against the raw body before anything is parsed.
 * An unsigned request that could delete a reader's data is exactly what the
 * check exists to stop.
 */
export async function POST(request: NextRequest) {
  const config = githubAppConfig();
  if (!config?.webhookSecret) return NextResponse.json({ error: "Webhooks are not configured." }, { status: 503 });

  const raw = await request.text();
  if (!verifyWebhook(raw, request.headers.get("x-hub-signature-256"), config.webhookSecret)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const event = request.headers.get("x-github-event");
  const supabase = createAdminClient();

  if (event === "push") {
    const push = payload as PushPayload;
    const repository = push.repository;
    if (!repository || !isDefaultBranchPush(push)) return NextResponse.json({ ignored: "not the default branch" });
    if (!touchesDependencies(push)) return NextResponse.json({ ignored: "no manifest changed" });

    // Several readers can watch the same repository. Each has their own row.
    const { data: rows, error } = await supabase
      .from("repositories")
      .update({ needs_read: true })
      .eq("github_id", repository.id)
      .eq("watching", true)
      .select("id");
    if (error) return NextResponse.json({ error: "Could not record the push." }, { status: 500 });

    if (rows && rows.length > 0) {
      try {
        await inngest.send(
          rows.map((row) => ({ name: EVENTS.guardPush, data: { repoId: row.id as string } satisfies GuardScanEvent }))
        );
      } catch (err) {
        // The flag is set, so the next sweep reads the repository anyway.
        console.error("github webhook: could not queue scans:", err);
      }
    }
    return NextResponse.json({ queued: rows?.length ?? 0 });
  }

  if (event === "installation") {
    const installationId = payload.installation?.id;
    if (typeof installationId !== "number") return NextResponse.json({ ignored: "no installation" });

    if (payload.action === "deleted") {
      // Cascades to every repository and finding that came through it.
      await supabase.from("github_installations").delete().eq("installation_id", installationId);
    } else if (payload.action === "suspend") {
      await supabase
        .from("github_installations")
        .update({ suspended_at: new Date().toISOString() })
        .eq("installation_id", installationId);
    } else if (payload.action === "unsuspend") {
      await supabase.from("github_installations").update({ suspended_at: null }).eq("installation_id", installationId);
    }
    return NextResponse.json({ ok: true });
  }

  if (event === "installation_repositories" && payload.action === "removed") {
    const installationId = payload.installation?.id;
    const removed: number[] = (payload.repositories_removed ?? []).map((r: { id: number }) => r.id);
    if (typeof installationId === "number" && removed.length > 0) {
      await supabase.from("repositories").delete().eq("installation_id", installationId).in("github_id", removed);
    }
    return NextResponse.json({ removed: removed.length });
  }

  // Added repositories are picked up when the reader comes back from GitHub's
  // screen, where their own access to each one can be checked.
  return NextResponse.json({ ignored: event ?? "unknown" });
}
