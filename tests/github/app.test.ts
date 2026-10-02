import { test, describe, before, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";

import {
  InstallationGone,
  appJwt,
  authorizeUrl,
  canStillRead,
  clearInstallationTokens,
  exchangeCode,
  fetchIdentity,
  githubAppConfig,
  installUrl,
  installationToken,
  listUserInstallationRepos,
  listUserInstallations,
  readPrivateKey,
  returnPath,
  signState,
  verifyState,
  verifyWebhook,
} from "@/lib/github/app";
import { appManifest, envFor } from "@/lib/github/manifest";
import { isDefaultBranchPush, touchesDependencies } from "@/lib/github/webhook";

/**
 * The GitHub App, without GitHub.
 *
 * None of this has been run against a real App yet: that needs one to be
 * registered. What can be established without one is here. The signatures
 * are real (a generated key, verified with its public half), and GitHub's
 * answers are stubbed in the shape its documentation gives.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// PKCS#1, which is the format GitHub hands out.
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "devlr-test",
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "shh",
  GITHUB_WEBHOOK_SECRET: "hook-secret",
};

before(() => {
  Object.assign(process.env, ENV, { APP_SECRET: "a-test-secret" });
});

afterEach(() => {
  mock.restoreAll();
  clearInstallationTokens();
});

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: any;
}

/** Replace global fetch. Each call is answered by `respond`. */
function stubFetch(respond: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body = {}, headers: responseHeaders = {} } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...responseHeaders } });
  });
  return calls;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("readPrivateKey", () => {
  /** The three spellings must all yield a key that signs, which is the only thing that matters. */
  const signs = (key: string) => {
    const [header, payload, signature] = appJwt({ appId: "1", privateKey: key }).split(".");
    return createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"));
  };

  test("a PEM is used as it is", () => {
    assert.equal(readPrivateKey(PEM).trim(), PEM.trim());
    assert.equal(signs(readPrivateKey(PEM)), true);
  });

  test("a PEM with its newlines written out, as a host's settings page stores it", () => {
    const NEWLINE = String.fromCharCode(10);
    const escaped = PEM.split(NEWLINE).join(String.fromCharCode(92) + "n");
    assert.ok(!escaped.includes(NEWLINE), "the test input really is one line");
    assert.equal(readPrivateKey(escaped).trim(), PEM.trim());
    assert.equal(signs(readPrivateKey(escaped)), true);
  });

  test("a PEM that was base64-encoded to survive an environment variable", () => {
    const encoded = Buffer.from(PEM).toString("base64");
    assert.equal(readPrivateKey(encoded), PEM);
    assert.equal(signs(readPrivateKey(`  ${encoded}  `)), true, "surrounding whitespace is ignored");
  });
});

describe("githubAppConfig", () => {
  test("is null until every required setting is present", () => {
    assert.equal(githubAppConfig({}), null);
    for (const missing of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"]) {
      assert.equal(githubAppConfig({ ...ENV, [missing]: "" }), null, missing);
    }
  });

  test("webhooks are optional", () => {
    const config = githubAppConfig({ ...ENV, GITHUB_WEBHOOK_SECRET: "" })!;
    assert.equal(config.webhookSecret, null);
    assert.equal(config.appId, "123456");
    assert.equal(githubAppConfig(ENV)!.webhookSecret, "hook-secret");
  });
});

describe("appJwt", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const seconds = now.getTime() / 1000;
  const jwt = appJwt({ appId: "123456", privateKey: PEM }, now);
  const [header, payload, signature] = jwt.split(".");

  test("is an RS256 token issued by the App", () => {
    assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
    assert.equal(decode(payload).iss, "123456");
  });

  test("is dated a minute back and expires inside GitHub's ten-minute limit", () => {
    const claims = decode(payload);
    assert.equal(claims.iat, seconds - 60);
    assert.equal(claims.exp, seconds + 540);
    assert.ok(claims.exp - claims.iat <= 600);
  });

  test("carries a signature the App's public key accepts, and no other key does", () => {
    const check = (key: typeof publicKey) =>
      createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(key, Buffer.from(signature, "base64url"));
    assert.equal(check(publicKey), true);
    assert.equal(check(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey), false);
  });

  test("a changed claim no longer verifies", () => {
    const forged = Buffer.from(JSON.stringify({ ...decode(payload), iss: "999" })).toString("base64url");
    const ok = createVerify("RSA-SHA256").update(`${header}.${forged}`).verify(publicKey, Buffer.from(signature, "base64url"));
    assert.equal(ok, false);
  });
});

describe("the state that ties a round trip to GitHub to one reader", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  test("is accepted for the reader it was issued to", () => {
    assert.equal(verifyState(signState("user-1", now), "user-1", later(5)), true);
  });

  test("is refused for anyone else", () => {
    assert.equal(verifyState(signState("user-1", now), "user-2", later(5)), false);
  });

  test("expires after half an hour", () => {
    const state = signState("user-1", now);
    assert.equal(verifyState(state, "user-1", later(29)), true);
    assert.equal(verifyState(state, "user-1", later(31)), false);
  });

  test("one dated in the future is refused", () => {
    assert.equal(verifyState(signState("user-1", later(10)), "user-1", now), false);
  });

  test("any change to it is refused", () => {
    const state = signState("user-1", now);
    const [user, issued, nonce, signature] = state.split(".");
    assert.equal(verifyState([user, issued, nonce, signature.replace(/.$/, "A")].join("."), "user-1", now), signature.endsWith("A"));
    assert.equal(verifyState(["user-2", issued, nonce, signature].join("."), "user-2", now), false);
    assert.equal(verifyState([user, (parseInt(issued, 36) + 1).toString(36), nonce, signature].join("."), "user-1", now), false);
  });

  test("garbage is refused without throwing", () => {
    for (const state of [null, undefined, "", "a.b.c", "a.b.c.d.e", "user-1...", "....", "x".repeat(500)]) {
      assert.equal(verifyState(state, "user-1", now), false, String(state));
    }
  });

  test("two issued in the same instant differ", () => {
    assert.notEqual(signState("user-1", now), signState("user-1", now));
  });

  test("a state signed under a different server secret is refused", () => {
    const state = signState("user-1", now);
    process.env.APP_SECRET = "another-secret";
    try {
      assert.equal(verifyState(state, "user-1", now), false);
    } finally {
      process.env.APP_SECRET = "a-test-secret";
    }
  });
});

describe("where the reader is sent", () => {
  test("to install: GitHub's screen for this App, carrying the state", () => {
    assert.equal(installUrl("a.b.c.d"), "https://github.com/apps/devlr-test/installations/new?state=a.b.c.d");
  });

  test("to identify: GitHub's authorise screen, with nothing but the client id and where to come back", () => {
    const url = new URL(authorizeUrl("st.ate", "https://devlr.example/api/github/callback"));
    assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      client_id: "Iv1.abc",
      state: "st.ate",
      redirect_uri: "https://devlr.example/api/github/callback",
    });
  });

  test("back afterwards: only to a screen on the list, never to wherever the URL says", () => {
    assert.equal(returnPath("/onboarding"), "/onboarding");
    assert.equal(returnPath("/app/repos"), "/app/repos");
    for (const hostile of ["https://evil.example", "//evil.example", "/app/settings", "", null, undefined]) {
      assert.equal(returnPath(hostile), "/app/repos", String(hostile));
    }
  });
});

describe("installationToken", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  test("asks GitHub as the App, and reuses the token while it is valid", async () => {
    const calls = stubFetch(() => ({ status: 201, body: { token: "ghs_one", expires_at: inMinutes(60) } }));

    assert.equal(await installationToken(77, now), "ghs_one");
    assert.equal(await installationToken(77, new Date(now.getTime() + 30 * 60_000)), "ghs_one");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.github.com/app/installations/77/access_tokens");
    assert.equal(calls[0].method, "POST");
    const jwt = calls[0].authorization!.replace("Bearer ", "");
    assert.equal(decode(jwt.split(".")[1]).iss, "123456", "the request is signed as the App, not with a stored token");
  });

  test("gets a new one before the old one can lapse mid-scan", async () => {
    let issued = 0;
    const calls = stubFetch(() => ({ status: 201, body: { token: `ghs_${++issued}`, expires_at: inMinutes(60) } }));

    assert.equal(await installationToken(77, now), "ghs_1");
    assert.equal(await installationToken(77, new Date(now.getTime() + 56 * 60_000)), "ghs_2");
    assert.equal(calls.length, 2);
  });

  test("each installation has its own token", async () => {
    stubFetch((call) => ({ status: 201, body: { token: `for-${call.url.match(/installations\/(\d+)/)![1]}`, expires_at: inMinutes(60) } }));
    assert.equal(await installationToken(1, now), "for-1");
    assert.equal(await installationToken(2, now), "for-2");
  });

  test("an installation that was removed or suspended is reported as gone", async () => {
    for (const status of [404, 403]) {
      stubFetch(() => ({ status }));
      await assert.rejects(installationToken(77, now), (err: unknown) => err instanceof InstallationGone && err.installationId === 77);
      mock.restoreAll();
    }
  });

  test("any other failure is an error, not a missing installation", async () => {
    stubFetch(() => ({ status: 502 }));
    await assert.rejects(installationToken(77, now), (err: unknown) => !(err instanceof InstallationGone) && /502/.test(String(err)));
  });
});

describe("establishing who came back from GitHub", () => {
  test("the code is exchanged for a token, with the App's client credentials", async () => {
    const calls = stubFetch(() => ({ body: { access_token: "ghu_user", token_type: "bearer" } }));
    assert.equal(await exchangeCode("the-code"), "ghu_user");
    assert.equal(calls[0].url, "https://github.com/login/oauth/access_token");
    assert.deepEqual(calls[0].body, { client_id: "Iv1.abc", client_secret: "shh", code: "the-code" });
  });

  test("a rejected code is an error with GitHub's own explanation", async () => {
    stubFetch(() => ({ body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } }));
    await assert.rejects(exchangeCode("stale"), /incorrect or expired/);
  });

  test("identity comes from GitHub, asked with that token", async () => {
    const calls = stubFetch(() => ({ body: { login: "ada", id: 42, email: "ada@example.com" } }));
    assert.deepEqual(await fetchIdentity("ghu_user"), { login: "ada", id: 42 });
    assert.equal(calls[0].authorization, "Bearer ghu_user");
  });

  test("the installations they can reach, across pages", async () => {
    const calls = stubFetch((call) =>
      call.url.includes("page=2")
        ? { body: { installations: [{ id: 3, account: { login: "acme", type: "Organization" }, suspended_at: "2026-01-01T00:00:00Z" }] } }
        : {
            body: { installations: [{ id: 1, account: { login: "ada", type: "User" }, suspended_at: null }] },
            headers: { link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next", <https://api.github.com/user/installations?per_page=100&page=2>; rel="last"' },
          }
    );

    assert.deepEqual(await listUserInstallations("ghu_user"), [
      { id: 1, accountLogin: "ada", accountType: "User", suspended: false },
      { id: 3, accountLogin: "acme", accountType: "Organization", suspended: true },
    ]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.authorization === "Bearer ghu_user"));
  });

  test("the repositories in one installation that this person can read", async () => {
    const calls = stubFetch(() => ({
      body: {
        repositories: [
          { id: 9, full_name: "acme/web", default_branch: "main", private: true, archived: false, pushed_at: "2026-09-30T10:00:00Z" },
          { id: 10, full_name: "acme/old", default_branch: "master", private: false, archived: true, pushed_at: null },
        ],
      },
    }));

    assert.deepEqual(await listUserInstallationRepos("ghu_user", 3), [
      { id: 9, fullName: "acme/web", defaultBranch: "main", private: true, archived: false, pushedAt: "2026-09-30T10:00:00Z" },
      { id: 10, fullName: "acme/old", defaultBranch: "master", private: false, archived: true, pushedAt: null },
    ]);
    assert.match(calls[0].url, /\/user\/installations\/3\/repositories\?per_page=100$/);
    assert.equal(calls[0].authorization, "Bearer ghu_user", "asked as the person, not as the installation");
  });

  test("a failure while listing is an error, never an empty list", async () => {
    stubFetch(() => ({ status: 500 }));
    await assert.rejects(listUserInstallations("ghu_user"), /500/);
  });
});

describe("canStillRead", () => {
  const ask = async (status: number, body: unknown = {}) => {
    stubFetch(() => ({ status, body }));
    const answer = await canStillRead("ghs_token", "acme/web", "ada");
    mock.restoreAll();
    return answer;
  };

  test("yes for any permission that is not none", async () => {
    for (const permission of ["read", "write", "admin"]) assert.equal(await ask(200, { permission }), true, permission);
  });

  test("no when GitHub says none, or does not know the account", async () => {
    assert.equal(await ask(200, { permission: "none" }), false);
    assert.equal(await ask(404), false);
  });

  test("no answer when GitHub will not say, so that a missing permission does not delete anyone's data", async () => {
    assert.equal(await ask(403), null);
    assert.equal(await ask(500), null);
    assert.equal(await ask(200, {}), false, "an answer with no permission in it is not a yes");
  });

  test("asks about the right account on the right repository", async () => {
    const calls = stubFetch(() => ({ body: { permission: "read" } }));
    await canStillRead("ghs_token", "acme/web", "ada lovelace");
    assert.equal(calls[0].url, "https://api.github.com/repos/acme/web/collaborators/ada%20lovelace/permission");
    assert.equal(calls[0].authorization, "Bearer ghs_token");
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify({ action: "deleted", installation: { id: 77 } });
  const sign = (text: string, secret = "hook-secret") => `sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;

  test("accepts a body signed with the shared secret", () => {
    assert.equal(verifyWebhook(body, sign(body), "hook-secret"), true);
  });

  test("refuses a body that was changed after signing, even by whitespace", () => {
    assert.equal(verifyWebhook(body.replace("77", "78"), sign(body), "hook-secret"), false);
    assert.equal(verifyWebhook(`${body} `, sign(body), "hook-secret"), false);
  });

  test("refuses a signature made with another secret", () => {
    assert.equal(verifyWebhook(body, sign(body, "guess"), "hook-secret"), false);
  });

  test("refuses a missing, legacy or malformed header without throwing", () => {
    const hex = sign(body).slice("sha256=".length);
    for (const header of [null, "", hex, `sha1=${hex}`, "sha256=", "sha256=zz", `sha256=${hex}00`]) {
      assert.equal(verifyWebhook(body, header, "hook-secret"), false, String(header));
    }
  });
});

describe("reading a push", () => {
  const push = (over: object = {}) => ({
    ref: "refs/heads/main",
    repository: { id: 9, default_branch: "main" },
    commits: [{ added: [], modified: ["src/index.ts"], removed: [] }],
    ...over,
  });

  test("only the default branch counts", () => {
    assert.equal(isDefaultBranchPush(push()), true);
    assert.equal(isDefaultBranchPush(push({ ref: "refs/heads/feature" })), false);
    assert.equal(isDefaultBranchPush(push({ ref: "refs/tags/v1.0.0" })), false);
    assert.equal(isDefaultBranchPush({ ref: "refs/heads/main" }), false);
  });

  test("source changes alone are not worth a scan", () => {
    assert.equal(touchesDependencies(push()), false);
    assert.equal(touchesDependencies(push({ commits: [] })), false);
  });

  test("a changed, added or removed manifest is", () => {
    assert.equal(touchesDependencies(push({ commits: [{ modified: ["package-lock.json"] }] })), true);
    assert.equal(touchesDependencies(push({ commits: [{ added: ["services/api/go.mod"] }] })), true);
    assert.equal(touchesDependencies(push({ commits: [{ removed: ["yarn.lock"] }] })), true);
    assert.equal(touchesDependencies(push({ commits: [{ modified: ["README.md"] }, { modified: ["requirements/prod.txt"] }] })), true);
  });

  test("so is a file that pins a runtime", () => {
    assert.equal(touchesDependencies(push({ commits: [{ modified: [".nvmrc"] }] })), true);
    assert.equal(touchesDependencies(push({ commits: [{ modified: ["docker/Dockerfile"] }] })), true);
  });

  test("a force push, or one too large to list, is assumed to have changed something", () => {
    assert.equal(touchesDependencies(push({ forced: true })), true);
    assert.equal(touchesDependencies(push({ commits: Array.from({ length: 20 }, () => ({ modified: ["src/x.ts"] })) })), true);
  });
});

describe("the App manifest", () => {
  test("asks for read access to contents and metadata, and nothing else", () => {
    assert.deepEqual(appManifest("https://devlr.example").default_permissions, { contents: "read", metadata: "read" });
  });

  test("has GitHub say who is installing, which is what makes linking verifiable", () => {
    const manifest = appManifest("https://devlr.example/");
    assert.equal(manifest.request_oauth_on_install, true);
    assert.deepEqual(manifest.callback_urls, ["https://devlr.example/api/github/callback"]);
    assert.equal(manifest.redirect_url, "https://devlr.example/setup/github/callback");
    assert.equal(manifest.public, true);
  });

  test("a deployed address gets push webhooks", () => {
    const manifest = appManifest("https://devlr.example");
    assert.deepEqual(manifest.hook_attributes, { url: "https://devlr.example/api/github/webhook", active: true });
    assert.deepEqual(manifest.default_events, ["push"]);
  });

  test("localhost gets none, because GitHub cannot reach it and refuses to try", () => {
    const manifest = appManifest("http://localhost:3000");
    assert.equal(manifest.hook_attributes, undefined);
    assert.equal(manifest.default_events, undefined);
  });

  test("the credentials come back as environment lines, with the key on one line and intact", () => {
    const env = envFor({
      id: 123456,
      slug: "devlr-test",
      name: "Devlr",
      html_url: "https://github.com/apps/devlr-test",
      client_id: "Iv1.abc",
      client_secret: "shh",
      webhook_secret: null,
      pem: PEM,
    });
    const lines = Object.fromEntries(env.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.deepEqual(Object.keys(lines), [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
    assert.equal(lines.GITHUB_WEBHOOK_SECRET, "");
    assert.equal(readPrivateKey(lines.GITHUB_APP_PRIVATE_KEY), PEM);
    // And those lines are exactly what the rest of the code reads back.
    assert.equal(githubAppConfig(lines)!.slug, "devlr-test");
  });
});
