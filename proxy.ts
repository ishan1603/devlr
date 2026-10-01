import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and the routes that never carry a
    // session: background job callbacks, and the token-authorised endpoints
    // reached from inside an email. Refreshing a session costs a round trip to
    // Supabase, and those requests have no session to refresh.
    "/((?!_next/static|_next/image|favicon.ico|api/inngest|api/v1|api/unsubscribe|api/feedback|feed/|issue/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
