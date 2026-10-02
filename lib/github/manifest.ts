/**
 * Creating the GitHub App.
 *
 * A GitHub App has a dozen settings, and Repo Guard depends on several of them
 * being exactly right: which permissions, which callback, whether GitHub asks
 * who is installing. Rather than a page of instructions to follow by hand,
 * GitHub accepts all of it as a "manifest", creates the App from that, and
 * hands back its credentials. This file is that manifest.
 *
 * It is used once, by whoever runs the deployment. See /setup/github.
 */

/**
 * The setup pages are a developer tool. They show the new App's credentials,
 * once, to the person who created it, so they are off in production unless
 * someone deliberately turns them on for a first-time setup.
 */
export function setupEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DEVLR_SETUP === "1";
}

export const SETUP_STATE_COOKIE = "devlr_setup_state";

export interface AppManifest {
  name: string;
  url: string;
  description: string;
  public: boolean;
  redirect_url: string;
  callback_urls: string[];
  request_oauth_on_install: boolean;
  default_permissions: Record<string, "read">;
  hook_attributes?: { url: string; active: boolean };
  default_events?: string[];
}

export function appManifest(baseUrl: string, name = "Devlr"): AppManifest {
  const base = baseUrl.replace(/\/$/, "");
  // GitHub will not deliver webhooks to an address it cannot reach, and
  // refuses a localhost one outright. Without them the daily sweep still
  // rescans everything. Pushes are just not picked up the minute they land.
  const reachable = base.startsWith("https://");

  return {
    name,
    url: base,
    description:
      "Reads the dependency manifests of the repositories you choose and tells you when something in them is vulnerable, hijacked, deprecated or past end of life. Never reads source code.",
    // Other people have to be able to install it. That is the product.
    public: true,
    redirect_url: `${base}/setup/github/callback`,
    callback_urls: [`${base}/api/github/callback`],
    // The setting linking depends on: GitHub then tells Devlr who installed
    // the App, which is how an installation id in a URL gets verified.
    request_oauth_on_install: true,
    // Read-only, and nothing beyond what a scan reads.
    default_permissions: { contents: "read", metadata: "read" },
    ...(reachable
      ? { hook_attributes: { url: `${base}/api/github/webhook`, active: true }, default_events: ["push"] }
      : {}),
  };
}

/** What GitHub returns when a manifest is turned into an App. */
export interface CreatedApp {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

/**
 * The lines to put in the environment. The private key is base64-encoded so
 * it survives as a single line, which is the only form most hosts accept.
 */
export function envFor(app: CreatedApp): string {
  return [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_APP_CLIENT_ID=${app.client_id}`,
    `GITHUB_APP_CLIENT_SECRET=${app.client_secret}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhook_secret ?? ""}`,
    `GITHUB_APP_PRIVATE_KEY=${Buffer.from(app.pem).toString("base64")}`,
  ].join("\n");
}
