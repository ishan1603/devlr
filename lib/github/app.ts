import { createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";

import { userAgent } from "@/lib/sources/http";

/**
 * Devlr's GitHub App: how a reader lets Devlr read their repositories.
 *
 * An App rather than an OAuth token with `repo` scope, for three reasons. The
 * reader picks the repositories on GitHub's own screen. The permission is read
 * access to contents and metadata, nothing else. And nothing long-lived is
 * stored: an installation token lasts an hour and is minted when a scan needs
 * one, so the database holds an installation id and no credential at all.
 *
 * Everything here is server-only. The private key signs requests as the App.
 */

const API = "https://api.github.com";

export interface GithubAppConfig {
  appId: string;
  /** The App's URL name, as in github.com/apps/<slug>. */
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  /** Absent when webhooks are not set up, which is fine: the daily sweep still runs. */
  webhookSecret: string | null;
}

/**
 * A PEM key from an environment variable. Hosts mangle multi-line values, so
 * two spellings are accepted: the PEM with its newlines written as `\n`, and
 * the whole file base64-encoded.
 */
export function readPrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN")) return trimmed.replace(/\\n/g, "\n");
  return Buffer.from(trimmed, "base64").toString("utf8");
}

/** The App's settings, or null when it has not been set up. */
export function githubAppConfig(env: Record<string, string | undefined> = process.env): GithubAppConfig | null {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET } = env;
  if (!GITHUB_APP_ID || !GITHUB_APP_SLUG || !GITHUB_APP_PRIVATE_KEY || !GITHUB_APP_CLIENT_ID || !GITHUB_APP_CLIENT_SECRET) {
    return null;
  }
  return {
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    privateKey: readPrivateKey(GITHUB_APP_PRIVATE_KEY),
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
  };
}

export const githubAppConfigured = () => githubAppConfig() !== null;

function requireConfig(): GithubAppConfig {
  const config = githubAppConfig();
  if (!config) throw new Error("The GitHub App is not configured. See SETUP.md.");
  return config;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/**
 * A JSON Web Token that identifies a request as coming from the App itself.
 *
 * Valid for nine minutes (GitHub's limit is ten), and dated a minute in the
 * past so a server clock that runs slightly ahead of GitHub's is not rejected.
 */
export function appJwt(config: Pick<GithubAppConfig, "appId" | "privateKey">, now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: config.appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(config.privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function github(path: string, init: RequestInit & { token: string }): Promise<Response> {
  const { token, ...rest } = init;
  return fetch(`${API}${path}`, {
    ...rest,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": userAgent(),
      authorization: `Bearer ${token}`,
      ...rest.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
}

// ---------------------------------------------------------------------------
// Installation tokens
// ---------------------------------------------------------------------------

const tokens = new Map<number, { token: string; expiresAt: number }>();
/** Stop using a token this long before it expires, so it cannot lapse mid-scan. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export class InstallationGone extends Error {
  constructor(readonly installationId: number) {
    super(`GitHub installation ${installationId} no longer exists or is suspended.`);
    this.name = "InstallationGone";
  }
}

/**
 * A token that can read the repositories of one installation, for an hour.
 *
 * Kept in memory only, and only for as long as it is valid. A serverless
 * instance that is recycled simply asks for a new one.
 */
export async function installationToken(installationId: number, now: Date = new Date()): Promise<string> {
  const cached = tokens.get(installationId);
  if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now.getTime()) return cached.token;

  const response = await github(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: appJwt(requireConfig(), now),
  });
  // 404: uninstalled. 403: suspended. Either way there is nothing to read.
  if (response.status === 404 || response.status === 403) {
    tokens.delete(installationId);
    throw new InstallationGone(installationId);
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked for an installation token.`);

  const data = (await response.json()) as { token: string; expires_at: string };
  tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
  return data.token;
}

/** For tests. */
export function clearInstallationTokens() {
  tokens.clear();
}

// ---------------------------------------------------------------------------
// Linking an installation to a reader
// ---------------------------------------------------------------------------

function stateSecret(): string {
  const base = process.env.APP_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error("APP_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set to link GitHub.");
  return `devlr-github-state:${base}`;
}

/** How long someone has to finish GitHub's install screen and come back. */
const STATE_TTL_MS = 30 * 60_000;

/**
 * The `state` sent out with the install link and expected back.
 *
 * It ties the round trip to the reader who started it. Without it, a link
 * crafted by someone else could attach their installation to this reader's
 * account, and this reader would start receiving reports about a stranger's
 * code, or worse, the reverse.
 */
export function signState(userId: string, now: Date = new Date()): string {
  const payload = `${userId}.${now.getTime().toString(36)}.${randomBytes(6).toString("base64url")}`;
  const signature = createHmac("sha256", stateSecret()).update(payload).digest("base64url").slice(0, 32);
  return `${payload}.${signature}`;
}

export function verifyState(state: string | null | undefined, userId: string, now: Date = new Date()): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [owner, issued, nonce, signature] = parts;

  const expected = createHmac("sha256", stateSecret()).update(`${owner}.${issued}.${nonce}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const age = now.getTime() - parseInt(issued, 36);
  return owner === userId && age >= 0 && age <= STATE_TTL_MS;
}

/** Where a reader may be sent back to after GitHub. Never taken from a URL as-is. */
const RETURN_PATHS = new Set(["/app/repos", "/onboarding"]);
/** Remembers, across the trip to GitHub, which screen the reader started from. */
export const GITHUB_RETURN_COOKIE = "devlr_github_return";

export function returnPath(candidate: string | null | undefined): string {
  return candidate && RETURN_PATHS.has(candidate) ? candidate : "/app/repos";
}

/** Where to send a reader to install the App, or to change which repositories it covers. */
export function installUrl(state: string): string {
  return `https://github.com/apps/${requireConfig().slug}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * Where to send a reader to say who they are on GitHub.
 *
 * This is the first stop, before any install screen. Someone whose
 * organisation already installed the App has nothing to install: they only
 * need to prove they can reach that installation, and this is how. A GitHub
 * App's user authorisation carries no scopes, so the consent screen asks for
 * nothing beyond identity.
 */
export function authorizeUrl(state: string, redirectUri: string): string {
  const query = new URLSearchParams({ client_id: requireConfig().clientId, state, redirect_uri: redirectUri });
  return `https://github.com/login/oauth/authorize?${query}`;
}

/**
 * Exchange the `code` GitHub appends to the redirect for a token that acts as
 * the person who just came back. It is used for a few requests to establish
 * who they are and what they can reach, and then dropped. It is never stored.
 */
export async function exchangeCode(code: string): Promise<string> {
  const config = requireConfig();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": userAgent() },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || "GitHub did not accept the authorisation code.");
  }
  return data.access_token;
}

export interface GithubIdentity {
  login: string;
  id: number;
}

export async function fetchIdentity(userToken: string): Promise<GithubIdentity> {
  const response = await github("/user", { token: userToken });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked who is signed in.`);
  const data = (await response.json()) as GithubIdentity;
  return { login: data.login, id: data.id };
}

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  suspended: boolean;
}

/** Follow GitHub's `Link: <...>; rel="next"` header until there is no next page. */
async function paginate<T>(firstPath: string, token: string, pick: (body: any) => T[], maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = firstPath;
  for (let page = 0; path && page < maxPages; page++) {
    const response: Response = await github(path, { token });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0]}.`);
    out.push(...pick(await response.json()));
    const next: string | undefined = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    path = next ? next.replace(API, "") : null;
  }
  return out;
}

/**
 * The installations of this App that the signed-in GitHub user can reach.
 *
 * This is the check that makes linking safe. The installation id in the
 * redirect is only a number in a URL. It is trusted only if it appears in
 * this list, which GitHub builds from what the person is actually allowed
 * to see.
 */
export async function listUserInstallations(userToken: string): Promise<Installation[]> {
  return paginate("/user/installations?per_page=100", userToken, (body) =>
    (body.installations ?? []).map((i: any) => ({
      id: i.id,
      accountLogin: i.account?.login ?? "",
      accountType: i.account?.type === "Organization" ? "Organization" : "User",
      suspended: Boolean(i.suspended_at),
    }))
  );
}

export interface AccessibleRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
}

const toRepo = (r: any): AccessibleRepo => ({
  id: r.id,
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  private: Boolean(r.private),
  archived: Boolean(r.archived),
  pushedAt: r.pushed_at ?? null,
});

/**
 * The repositories in an installation that this person can read.
 *
 * Asked with the person's token, not the installation's, on purpose. An
 * organisation's installation may cover repositories a given member has no
 * access to, and those must not appear in that member's Devlr account.
 */
export async function listUserInstallationRepos(userToken: string, installationId: number): Promise<AccessibleRepo[]> {
  return paginate(`/user/installations/${installationId}/repositories?per_page=100`, userToken, (body) =>
    (body.repositories ?? []).map(toRepo)
  );
}

/**
 * Can this GitHub account still read this repository?
 *
 * Asked with the installation's token before a scan, so that someone who has
 * left an organisation stops receiving reports about its code. Returns null
 * when GitHub will not say (the App lacks the permission to ask), which the
 * caller treats as "no change" rather than as a yes or a no.
 */
export async function canStillRead(token: string, fullName: string, login: string): Promise<boolean | null> {
  const response = await github(`/repos/${fullName}/collaborators/${encodeURIComponent(login)}/permission`, { token });
  if (response.status === 404) return false;
  if (!response.ok) return null;
  const data = (await response.json()) as { permission?: string };
  return data.permission !== undefined && data.permission !== "none";
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Is this webhook really from GitHub?
 *
 * GitHub signs the exact bytes of the body with the shared secret. The
 * comparison is constant-time, and the body must be the raw text as received:
 * parsing and re-serialising it would change the bytes and fail every check.
 */
export function verifyWebhook(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
