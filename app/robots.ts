import type { MetadataRoute } from "next";

/**
 * Only the public pages are worth indexing. Everything else is either behind
 * sign-in or reached by an unguessable token, and a token URL in a search
 * index is a leaked token.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app/", "/api/", "/onboarding", "/demo/", "/issue/", "/feed/", "/f/", "/auth/", "/unsubscribe"],
    },
  };
}
