"use client";

import { DEMO_ME } from "@/lib/demo";
import { SAMPLE_ISSUE } from "@/lib/sample-issue";
import type { Me } from "@/lib/profile";

/**
 * Answers the app's own API calls from memory while under /demo.
 *
 * The demo renders the real components, and those call /api/me, /api/preview
 * and so on. Rather than teach each component about a "demo mode", the calls
 * are intercepted here, in one place, and the components stay unaware.
 *
 * Installed when this module is evaluated, not in an effect: child components'
 * effects run before a parent's, so an effect here would be too late for a
 * child that fetches on mount. Only /api/ requests are touched, and everything
 * else, including the router's own fetches, passes straight through.
 */

declare global {
  interface Window {
    __devlrDemoFetch?: typeof fetch;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (typeof window !== "undefined" && !window.__devlrDemoFetch) {
  const realFetch = window.fetch.bind(window);
  window.__devlrDemoFetch = realFetch;

  let me: Me = structuredClone(DEMO_ME);

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.origin).pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    // Leaving the demo restores normal behaviour for the rest of the session.
    if (!window.location.pathname.startsWith("/demo") || !path.startsWith("/api/")) {
      return realFetch(input, init);
    }

    await sleep(350);

    if (path === "/api/me" && method === "PUT") {
      const patch = JSON.parse(String(init?.body ?? "{}"));
      const { subscriptions, complete_onboarding, ...profile } = patch;
      me = {
        profile: {
          ...me.profile,
          ...profile,
          ...(complete_onboarding ? { onboarded_at: new Date().toISOString() } : {}),
        },
        subscriptions: subscriptions
          ? subscriptions.map((s: Omit<Me["subscriptions"][number], "last_sent_at">) => ({
              ...s,
              last_sent_at: null,
            }))
          : me.subscriptions,
      };
      return json(me);
    }
    if (path === "/api/me") return json(me);
    if (path === "/api/preview") {
      await sleep(500);
      return json({ issue: SAMPLE_ISSUE });
    }
    if (path === "/api/send-now") return json({ queued: true });
    if (path === "/api/account") return json({ deleted: true });

    return json({ error: "Not available in the demo." }, 404);
  };
}

export default function DemoApi() {
  return null;
}
