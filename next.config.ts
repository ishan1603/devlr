import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The version header tells an attacker which advisories to try first.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Stops a browser guessing a content type the server did not send.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Nothing here is meant to be embedded in another site's frame.
          { key: "X-Frame-Options", value: "DENY" },
          // Outbound clicks reveal the site, not the page. Issue and feedback
          // URLs carry tokens, and a full referrer would hand them to every
          // article a reader opens.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
        ],
      },
      {
        // Token-addressed pages: never cache in a shared cache, never index.
        source: "/(issue|feed|f)/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
