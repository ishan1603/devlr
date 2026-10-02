import type { DeliveryRow } from "@/components/app/views";
import type { Me } from "@/lib/profile";

/**
 * The /demo area: every signed-in screen, rendered with made-up data.
 *
 * It exists so the interface can be built, reviewed and screenshot-tested
 * without a database or an account. It is on in development and off in
 * production unless DEVLR_DEMO=1 is set, in which case the routes 404.
 *
 * Nothing under /demo reads or writes real data. The pages use the same
 * components as the real app, and a small client module answers their API
 * calls from memory (components/demo/DemoApi.tsx).
 */
export function demoEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DEVLR_DEMO === "1";
}

const SUBSCRIPTIONS: Me["subscriptions"] = [
  { module: "digest", is_active: true, frequency: "weekly", custom_interval_days: null, last_sent_at: "2026-09-28T02:30:00Z" },
  { module: "dev_pulse", is_active: true, frequency: "weekly", custom_interval_days: null, last_sent_at: "2026-09-28T02:30:00Z" },
  { module: "eol_watch", is_active: true, frequency: "daily", custom_interval_days: null, last_sent_at: "2026-09-28T02:30:00Z" },
  { module: "repo_guard", is_active: true, frequency: "daily", custom_interval_days: null, last_sent_at: "2026-10-01T02:30:00Z" },
];

export const DEMO_ME: Me = {
  profile: {
    user_id: "00000000-0000-4000-8000-000000000001",
    email: "ada@example.com",
    display_name: "Ada Lovelace",
    level: "senior",
    domains: ["backend", "frontend"],
    stack: ["typescript", "nextjs", "react", "postgres", "nodejs"],
    digest_length: "standard",
    timezone: "Asia/Kolkata",
    send_time: "08:00",
    is_paused: false,
    onboarding_step: "done",
    onboarded_at: "2026-09-01T08:00:00Z",
    feed_token: "00000000-0000-4000-8000-00000000feed",
    last_delivery_at: "2026-09-28T02:30:00Z",
    created_at: "2026-09-01T08:00:00Z",
  },
  subscriptions: SUBSCRIPTIONS,
};

/** Someone who has just created an account and chosen nothing yet. */
export const DEMO_ME_NEW: Me = {
  profile: {
    ...DEMO_ME.profile,
    display_name: null,
    level: "mid",
    domains: [],
    stack: [],
    timezone: "UTC",
    onboarding_step: "domains",
    onboarded_at: null,
    last_delivery_at: null,
  },
  subscriptions: [],
};

const demoIssue = (id: number, rest: Partial<DeliveryRow> & Pick<DeliveryRow, "status" | "created_at">): DeliveryRow => ({
  id: `demo-${id}`,
  subject: null,
  preheader: null,
  modules: [],
  web_token: `demo-${id}`,
  sent_at: rest.status === "sent" ? rest.created_at : null,
  href: "/demo/email",
  ...rest,
});

export const DEMO_DELIVERIES: DeliveryRow[] = [
  demoIssue(1, {
    status: "sent",
    created_at: "2026-10-01T02:30:00Z",
    subject: "EDG opens its C++ front end, Shopify drops React Native",
    preheader: "Plus a 4.57% faster Rust compiler, and Next.js 15 reaches end of life in 20 days.",
    modules: ["eol_watch", "digest", "dev_pulse"],
  }),
  demoIssue(6, {
    status: "sent",
    created_at: "2026-09-30T11:42:00Z",
    subject: "next 15.4.5 in storefront: 31 advisories, 3 critical",
    preheader: "Upgrade to 15.5.24.",
    modules: ["repo_guard"],
    href: "/demo/email?view=alert",
  }),
  demoIssue(2, { status: "skipped", created_at: "2026-09-30T02:30:00Z" }),
  demoIssue(3, {
    status: "sent",
    created_at: "2026-09-28T02:30:00Z",
    subject: "Node.js 22.23.3 fixes an HTTP parser leak",
    preheader: "Also: Terraform 1.16 completes Actions lifecycles, and handling hot shards at PlanetScale.",
    modules: ["digest", "dev_pulse"],
  }),
  demoIssue(4, {
    status: "failed",
    created_at: "2026-09-24T02:30:00Z",
    error: "All mail transports failed. gmail: Daily user sending limit exceeded",
    modules: ["digest"],
  }),
  demoIssue(5, {
    status: "sent",
    created_at: "2026-09-21T02:30:00Z",
    subject: "Python 3.10 reaches end of life in 40 days",
    preheader: "Three versions in your stack lose support before the end of the year.",
    modules: ["eol_watch", "digest"],
  }),
];
