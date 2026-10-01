import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/server";

/**
 * Exchanges an emailed auth link for a real session.
 *
 * The app went without this route for a long time, which is why email
 * confirmation could never work: `@supabase/ssr` uses the PKCE flow, so links
 * arrive carrying a `code` that has to be traded for a session server-side.
 * With nowhere to trade it, every confirmation link dead-ended.
 *
 * Two link shapes are handled because Supabase emits both depending on the
 * template: `?code=` (PKCE) and `?token_hash=&type=` (the OTP-style link used
 * by newer default templates).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  // Only same-origin paths, so a crafted link cannot bounce someone off-site.
  const requested = searchParams.get("next") ?? "/app";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/app";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error("Auth callback: code exchange failed:", error.message);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "recovery" | "email" | "signup" | "invite" | "email_change",
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error("Auth callback: OTP verification failed:", error.message);
  }

  return NextResponse.redirect(
    `${origin}/signin?error=${encodeURIComponent("That link is invalid or has expired. Request a new one.")}`
  );
}
