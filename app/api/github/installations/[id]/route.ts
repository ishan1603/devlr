import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/server";
import { unlinkInstallation } from "@/lib/guard/repos";

/**
 * Disconnect a GitHub account from Devlr.
 *
 * This removes Devlr's record of the installation for this reader, along with
 * its repositories and findings. It does not uninstall the App on GitHub:
 * that is the reader's to do there, and someone else in their organisation
 * may still be using it.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const installationId = Number(id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Scoped to this reader by the delete itself: it names their user id.
  await unlinkInstallation(user.id, installationId);
  return NextResponse.json({ ok: true });
}
