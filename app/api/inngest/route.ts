import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions/functions";

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  // Background jobs read other users' rows and so cannot use the cookie-scoped
  // client. Under RLS, missing this key makes every run cancel itself with
  // "profile not found", which is easy to misread as a data problem.
  console.warn(
    "[inngest] SUPABASE_SERVICE_ROLE_KEY is not set. Background jobs will not be able to read or write."
  );
}

// Steps fetch feeds and call models. This is the ceiling a single step gets.
export const maxDuration = 60;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
