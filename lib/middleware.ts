import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Paths that need a session. Everything else is public. */
const PROTECTED = ["/app", "/onboarding"];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Do not run code between createServerClient and supabase.auth.getUser().
  // A simple mistake there makes it very hard to debug users being randomly
  // logged out.
  //
  // IMPORTANT: DO NOT REMOVE auth.getUser()
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const redirectTo = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    const response = NextResponse.redirect(url);
    // Carry over any refreshed session cookies, or the redirect would drop them
    // and sign the user out.
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  };

  // Signed-in visitors skip the marketing page and the sign-in form. A
  // signed-out visitor stays on "/", which is the whole point of having one.
  if (user && (pathname === "/" || pathname === "/signin")) return redirectTo("/app");

  if (!user && PROTECTED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return redirectTo("/signin");
  }

  // IMPORTANT: return the supabaseResponse object as it is. If you create a new
  // response, copy its cookies across (as redirectTo does above). Otherwise the
  // browser and server fall out of sync and the session ends early.
  return supabaseResponse;
}
