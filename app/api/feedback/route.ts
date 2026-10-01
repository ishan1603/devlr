import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verifyFeedback } from "@/lib/delivery/tokens";

/**
 * Records "more like this" or "less like this".
 *
 * POST only. The link in the email is a GET to a page, and that page posts
 * here from the browser. Mailbox scanners and link previewers fetch every URL
 * in a message, so anything that acted on GET would record votes nobody cast.
 *
 * The signed token is the authorisation, which is why this works with no
 * session and uses the service role.
 */
export async function POST(request: NextRequest) {
  let token: unknown;
  try {
    ({ token } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const claim = typeof token === "string" ? verifyFeedback(token) : null;
  if (!claim) return NextResponse.json({ error: "This link is not valid." }, { status: 400 });

  const supabase = createAdminClient();

  // Copy what the vote is about onto the row. Content is pruned after 60 days
  // and the preference has to outlive the article.
  const { data: item } = await supabase
    .from("content_items")
    .select("title, tags, site, source_id")
    .eq("cluster_id", claim.ref)
    .not("summary", "is", null)
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("feedback").upsert(
    {
      user_id: claim.userId,
      item_ref: claim.ref,
      signal: claim.signal,
      tags: item?.tags ?? [],
      site: item?.site ?? null,
      source_id: item?.source_id ?? null,
      created_at: new Date().toISOString(),
    },
    { onConflict: "user_id,item_ref" }
  );
  if (error) {
    console.error("feedback failed:", error.message);
    return NextResponse.json({ error: "Could not save that." }, { status: 500 });
  }

  return NextResponse.json({ saved: true, signal: claim.signal, title: item?.title ?? null });
}
