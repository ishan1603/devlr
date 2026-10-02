import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/server";
import { appUrl } from "@/lib/delivery/tokens";
import {
  GITHUB_RETURN_COOKIE,
  authorizeUrl,
  githubAppConfigured,
  installUrl,
  returnPath,
  signState,
} from "@/lib/github/app";

/**
 * Start connecting GitHub.
 *
 * The default leg asks GitHub who the reader is, which is all that someone
 * whose organisation already has the App installed needs. `?mode=install`
 * goes to GitHub's own screen for choosing repositories instead, used when
 * there is nothing installed yet or the reader wants to change the selection.
 *
 * Either way the reader comes back through /api/github/callback, carrying a
 * `state` that only this server could have issued to this reader.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${appUrl()}/signin`);

  const back = returnPath(request.nextUrl.searchParams.get("from"));
  if (!githubAppConfigured()) return NextResponse.redirect(`${appUrl()}${back}?github=unavailable`);

  const state = signState(user.id);
  const target =
    request.nextUrl.searchParams.get("mode") === "install"
      ? installUrl(state)
      : authorizeUrl(state, `${appUrl()}/api/github/callback`);

  const store = await cookies();
  store.set(GITHUB_RETURN_COOKIE, back, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/github",
    maxAge: 30 * 60,
  });
  return NextResponse.redirect(target);
}
