import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { renderBadge, type BadgeState } from "@/lib/guard/badge";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function svg(state: BadgeState, status = 200, maxAge = 1800): Response {
  return new Response(renderBadge(state), {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // GitHub proxies README images and caches them. Half an hour keeps a
      // badge honest without a request per page view.
      "cache-control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * A repository's dependency grade, for its README.
 *
 *   /badge/<token>.svg
 *
 * The token is the repository's badge token, which authorises reading this
 * one thing: a letter and a score. It is not the repository's id and gives no
 * way to reach anything else about it.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const token = (await context.params).token.replace(/\.svg$/i, "");
  if (!UUID.test(token)) return svg({ status: "not found" }, 404, 300);

  const { data } = await createAdminClient()
    .from("repositories")
    .select("health_grade, health_score, scan_status, watching")
    .eq("badge_token", token)
    .maybeSingle();

  if (!data) return svg({ status: "not found" }, 404, 300);
  // A repo that is no longer watched has a grade from whenever it last was.
  // Showing it would be showing a number nobody is keeping true.
  if (!data.watching) return svg({ status: "not watched" });
  if (data.health_grade === null || data.health_score === null) return svg({ status: "pending" }, 200, 120);

  return svg({ grade: data.health_grade as string, score: data.health_score as number });
}
