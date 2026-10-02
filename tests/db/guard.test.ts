import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { as, asService, closeDatabase, createUser, db, errorCode, openDatabase, rows } from "./harness";

/**
 * Repo Guard's tables and functions, run against a real Postgres.
 *
 * The part worth the most care is "tell me once". It is decided entirely in
 * SQL (guard_apply_scan, guard_mark_notified, guard_pending_users), so this
 * is where it is pinned down: a mock could not show that a finding which was
 * fixed and came back is announced again, or that one which was not is left
 * alone.
 */

before(openDatabase);
after(closeDatabase);

let nextGithubId = 1000;

async function addRepo(userId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const row = { user_id: userId, github_id: nextGithubId++, full_name: "acme/web", ...fields };
  const keys = Object.keys(row);
  const [created] = await rows<{ id: string }>(
    `insert into public.repositories (${keys.join(", ")})
     values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row)
  );
  return created.id;
}

async function linkInstallation(userId: string, installationId: number, login = "alice") {
  await db.query(
    `insert into public.github_installations (user_id, installation_id, account_login, github_login)
     values ($1, $2, 'acme', $3)`,
    [userId, installationId, login]
  );
}

type Incoming = { key: string; priority?: string; kind?: string; group_key?: string };

const finding = (f: Incoming) => ({
  key: f.key,
  group_key: f.group_key ?? "npm:next",
  kind: f.kind ?? "vulnerability",
  priority: f.priority ?? "high",
});

/** Apply a scan the way the background job does. */
async function scan(repoId: string, findings: Incoming[], state: Record<string, unknown> = {}) {
  const [row] = await rows<{ result: Record<string, any> }>(
    "select public.guard_apply_scan($1, $2::jsonb, $3::jsonb) as result",
    [repoId, JSON.stringify(findings.map(finding)), JSON.stringify(state)]
  );
  return row.result;
}

async function findings(repoId: string) {
  return rows(
    `select id, key, priority, status, notified_at, notified_priority, first_seen_at, last_seen_at, resolved_at
       from public.repo_findings where repo_id = $1 order by key`,
    [repoId]
  );
}

async function markNotified(repoId: string, keys?: string[]) {
  const ids = (await findings(repoId)).filter((f) => !keys || keys.includes(f.key)).map((f) => f.id);
  const [{ count }] = await rows("select public.guard_mark_notified($1::bigint[]) as count", [ids]);
  return count as number;
}

async function pendingFor(userId: string) {
  const [row] = await rows("select pending, urgent from public.guard_pending_users() where user_id = $1", [userId]);
  return row ?? null;
}

describe("guard_apply_scan", () => {
  let user: string;
  before(async () => {
    user = await createUser();
  });

  test("a first scan records every finding and the state of the repo", async () => {
    const repo = await addRepo(user);
    const result = await scan(
      repo,
      [{ key: "vulnerability:npm:next:GHSA-1", priority: "urgent" }, { key: "vulnerability:npm:next:GHSA-2" }],
      {
        scanned_ref: "main",
        pushed_at: "2026-09-30T10:00:00Z",
        default_branch: "main",
        health_score: 55,
        health_grade: "D",
        counts: { urgent: 1, high: 0, medium: 0, low: 0 },
        stats: { dependencies: 613 },
        report: [{ key: "npm:next", title: "next 15.4.5 has 2 known vulnerabilities" }],
        inventory: { dependencies: [["npm", "next", "15.4.5"]] },
        notes: ["a note"],
      }
    );

    assert.deepEqual(result, { user_id: user, added: 2, reopened: 0, resolved: 0, pending: 2, pending_urgent: 1 });

    const [row] = await rows("select * from public.repositories where id = $1", [repo]);
    assert.equal(row.scan_status, "ok");
    assert.equal(row.needs_read, false);
    assert.ok(row.scanned_at);
    assert.deepEqual([row.health_score, row.health_grade, row.default_branch], [55, "D", "main"]);
    assert.deepEqual(row.counts, { urgent: 1, high: 0, medium: 0, low: 0 });
    assert.equal(row.report[0].key, "npm:next");
    assert.deepEqual(row.inventory, { dependencies: [["npm", "next", "15.4.5"]] });
    assert.deepEqual(row.notes, ["a note"]);

    const stored = await findings(repo);
    assert.deepEqual(stored.map((f) => [f.key, f.priority, f.status]), [
      ["vulnerability:npm:next:GHSA-1", "urgent", "open"],
      ["vulnerability:npm:next:GHSA-2", "high", "open"],
    ]);
  });

  test("scanning again with the same findings changes nothing a reader would notice", async () => {
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a" }, { key: "b" }]);
    await markNotified(repo);
    const before = await findings(repo);

    const result = await scan(repo, [{ key: "a" }, { key: "b" }]);
    assert.deepEqual(
      [result.added, result.reopened, result.resolved, result.pending, result.pending_urgent],
      [0, 0, 0, 0, 0]
    );

    const after = await findings(repo);
    assert.deepEqual(after.map((f) => f.notified_at), before.map((f) => f.notified_at), "told once stays told");
    assert.deepEqual(after.map((f) => f.first_seen_at), before.map((f) => f.first_seen_at));
  });

  test("a finding missing from a later scan is resolved, not deleted", async () => {
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a" }, { key: "b" }]);
    const result = await scan(repo, [{ key: "a" }]);

    assert.deepEqual([result.added, result.resolved, result.pending], [0, 1, 1]);
    const [a, b] = await findings(repo);
    assert.deepEqual([a.status, a.resolved_at], ["open", null]);
    assert.equal(b.status, "resolved");
    assert.ok(b.resolved_at);
  });

  test("a clean scan resolves everything", async () => {
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a" }, { key: "b" }]);
    const result = await scan(repo, []);
    assert.deepEqual([result.resolved, result.pending], [2, 0]);
    assert.ok((await findings(repo)).every((f) => f.status === "resolved"));
  });

  test("a finding that was fixed and comes back is news again", async () => {
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a" }]);
    await markNotified(repo);
    await scan(repo, []);

    const result = await scan(repo, [{ key: "a" }]);
    assert.deepEqual([result.added, result.reopened, result.pending], [0, 1, 1]);
    const [a] = await findings(repo);
    assert.deepEqual([a.status, a.notified_at, a.notified_priority, a.resolved_at], ["open", null, null, null]);
  });

  test("a change of priority is recorded, and becoming urgent after being announced is urgent news", async () => {
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a", priority: "medium" }, { key: "b", priority: "urgent" }]);
    await markNotified(repo);

    const calm = await scan(repo, [{ key: "a", priority: "high" }, { key: "b", priority: "urgent" }]);
    assert.deepEqual([calm.pending, calm.pending_urgent], [0, 0], "more pressing, but not urgent, is not re-announced");

    const loud = await scan(repo, [{ key: "a", priority: "urgent" }, { key: "b", priority: "urgent" }]);
    assert.deepEqual([loud.pending, loud.pending_urgent], [0, 1], "only the one that was announced when it was calmer");
    const [a] = await findings(repo);
    assert.deepEqual([a.priority, a.notified_priority], ["urgent", "medium"]);
  });

  test("the stored inventory survives a scan that did not re-read the files", async () => {
    const repo = await addRepo(user);
    await scan(repo, [], { inventory: { dependencies: [["npm", "ms", "2.1.3"]] }, runtimes: [{ product: "nodejs" }] });
    await scan(repo, [], { health_score: 100, health_grade: "A" });

    const [row] = await rows("select inventory, runtimes, health_grade from public.repositories where id = $1", [repo]);
    assert.deepEqual(row.inventory, { dependencies: [["npm", "ms", "2.1.3"]] });
    assert.deepEqual(row.runtimes, [{ product: "nodejs" }]);
    assert.equal(row.health_grade, "A");
  });

  test("a scan clears an earlier failure", async () => {
    const repo = await addRepo(user, { scan_status: "failed", scan_error: "GitHub answered 502" });
    await scan(repo, []);
    const [row] = await rows("select scan_status, scan_error from public.repositories where id = $1", [repo]);
    assert.deepEqual([row.scan_status, row.scan_error], ["ok", null]);
  });

  test("the same key twice in one scan is one finding, not an error", async () => {
    const repo = await addRepo(user);
    const result = await scan(repo, [{ key: "a" }, { key: "a" }]);
    assert.equal(result.added, 1);
    assert.equal((await findings(repo)).length, 1);
  });

  test("findings belong to their own repo: the same key elsewhere is untouched", async () => {
    const one = await addRepo(user);
    const two = await addRepo(user);
    await scan(one, [{ key: "a" }]);
    await scan(two, [{ key: "a" }]);
    await scan(one, []);
    assert.equal((await findings(one))[0].status, "resolved");
    assert.equal((await findings(two))[0].status, "open");
  });

  test("a repository that does not exist is an error, not a silent no-op", async () => {
    const code = await errorCode(() => scan("00000000-0000-0000-0000-000000000000", []));
    assert.equal(code, "P0002");
  });
});

describe("guard_mark_notified", () => {
  test("records when the reader was told, and how pressing it was then", async () => {
    const repo = await addRepo(await createUser());
    await scan(repo, [{ key: "a", priority: "medium" }, { key: "b", priority: "urgent" }]);

    assert.equal(await markNotified(repo, ["a"]), 1);
    const [a, b] = await findings(repo);
    assert.ok(a.notified_at);
    assert.equal(a.notified_priority, "medium");
    assert.deepEqual([b.notified_at, b.notified_priority], [null, null]);
  });

  test("a finding resolved in the meantime is not marked", async () => {
    const repo = await addRepo(await createUser());
    await scan(repo, [{ key: "a" }]);
    const [{ id }] = await findings(repo);
    await scan(repo, []);
    const [{ count }] = await rows("select public.guard_mark_notified($1::bigint[]) as count", [[id]]);
    assert.equal(count, 0);
  });
});

describe("guard_pending_users", () => {
  test("lists a reader while they have something they have not been told", async () => {
    const user = await createUser();
    const repo = await addRepo(user);
    assert.equal(await pendingFor(user), null);

    await scan(repo, [{ key: "a" }, { key: "b", priority: "urgent" }]);
    assert.deepEqual(await pendingFor(user), { pending: 2, urgent: 1 });

    await markNotified(repo);
    assert.equal(await pendingFor(user), null);
  });

  test("counts across all of a reader's repositories", async () => {
    const user = await createUser();
    await scan(await addRepo(user), [{ key: "a" }]);
    await scan(await addRepo(user), [{ key: "a" }, { key: "b" }]);
    assert.deepEqual(await pendingFor(user), { pending: 3, urgent: 0 });
  });

  test("a repository that is no longer watched has nothing to say", async () => {
    const user = await createUser();
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a", priority: "urgent" }]);
    await db.query("update public.repositories set watching = false where id = $1", [repo]);
    assert.equal(await pendingFor(user), null);
  });

  test("an announced finding that turns urgent brings the reader back, as urgent only", async () => {
    const user = await createUser();
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a", priority: "medium" }]);
    await markNotified(repo);
    await scan(repo, [{ key: "a", priority: "urgent" }]);
    assert.deepEqual(await pendingFor(user), { pending: 0, urgent: 1 });

    await markNotified(repo);
    assert.equal(await pendingFor(user), null, "told at urgent, so it is settled");
  });

  test("resolved findings are never pending", async () => {
    const user = await createUser();
    const repo = await addRepo(user);
    await scan(repo, [{ key: "a" }]);
    await scan(repo, []);
    assert.equal(await pendingFor(user), null);
  });
});

describe("repositories and installations", () => {
  test("a new repository starts unscanned, watched, with a badge token of its own", async () => {
    const user = await createUser();
    const [a] = await rows("select * from public.repositories where id = $1", [await addRepo(user)]);
    const [b] = await rows("select * from public.repositories where id = $1", [await addRepo(user)]);
    assert.deepEqual([a.scan_status, a.watching, a.needs_read, a.scanned_at], ["pending", true, true, null]);
    assert.match(a.badge_token, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.badge_token, b.badge_token);
  });

  test("one reader cannot watch the same repository twice, but two readers can each watch it", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await addRepo(alice, { github_id: 42 });
    await addRepo(bob, { github_id: 42 });
    assert.equal(await errorCode(() => addRepo(alice, { github_id: 42 })), "23505");
  });

  test("values outside what the app writes are rejected", async () => {
    const user = await createUser();
    const repo = await addRepo(user);
    assert.equal(await errorCode(() => addRepo(user, { scan_status: "exploded" })), "23514");
    assert.equal(await errorCode(() => addRepo(user, { health_score: 101 })), "23514");
    assert.equal(await errorCode(() => addRepo(user, { health_grade: "E" })), "23514");
    assert.equal(await errorCode(() => scan(repo, [{ key: "a", priority: "catastrophic" }])), "23514");
    assert.equal(await errorCode(() => scan(repo, [{ key: "a", kind: "rumour" }])), "23514");
  });

  test("a repository can only point at an installation its owner has linked", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await linkInstallation(alice, 501);
    await addRepo(alice, { installation_id: 501 });
    assert.equal(await errorCode(() => addRepo(bob, { installation_id: 501 })), "23503");
  });

  test("two people can link the same installation, once each", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await linkInstallation(alice, 502, "alice");
    await linkInstallation(bob, 502, "bob");
    assert.equal(await errorCode(() => linkInstallation(alice, 502)), "23505");
  });

  test("unlinking an installation removes its repositories and their findings, and nobody else's", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await linkInstallation(alice, 503, "alice");
    await linkInstallation(bob, 503, "bob");
    const hers = await addRepo(alice, { installation_id: 503 });
    const herPublic = await addRepo(alice);
    const his = await addRepo(bob, { installation_id: 503 });
    for (const repo of [hers, herPublic, his]) await scan(repo, [{ key: "a" }]);

    await db.query("delete from public.github_installations where user_id = $1 and installation_id = 503", [alice]);

    const left = await rows("select id from public.repositories where id = any($1::uuid[])", [[hers, herPublic, his]]);
    assert.deepEqual(left.map((r) => r.id).sort(), [herPublic, his].sort());
    assert.equal((await findings(hers)).length, 0);
    assert.equal((await findings(his)).length, 1);
  });

  test("deleting the account removes every trace", async () => {
    const user = await createUser();
    await linkInstallation(user, 504);
    const repo = await addRepo(user, { installation_id: 504 });
    await scan(repo, [{ key: "a" }]);

    await db.query("delete from auth.users where id = $1", [user]);

    for (const table of ["github_installations", "repositories", "repo_findings"]) {
      const [{ count }] = await rows(`select count(*)::int as count from public.${table} where user_id = $1`, [user]);
      assert.equal(count, 0, `${table} still has rows for a deleted account`);
    }
  });
});

describe("row level security", () => {
  let alice: string;
  let bob: string;
  let aliceRepo: string;

  before(async () => {
    alice = await createUser();
    bob = await createUser();
    await linkInstallation(alice, 601, "alice");
    await linkInstallation(bob, 602, "bob");
    aliceRepo = await addRepo(alice, { installation_id: 601, full_name: "alice/private", is_private: true });
    await scan(aliceRepo, [{ key: "a" }], { inventory: { dependencies: [["npm", "secret-internal-lib", "1.0.0"]] } });
    await scan(await addRepo(bob, { installation_id: 602 }), [{ key: "a" }]);
    await db.query("insert into public.guard_advisories (id, data) values ('GHSA-rls', '{}')");
    await db.query("insert into public.guard_package_status (key) values ('npm:x@1.0.0')");
    await db.query("insert into public.guard_cache (key, data) values ('kev', '[]')");
  });

  test("a reader sees their own installations, repositories and findings, and nobody else's", async () => {
    for (const table of ["github_installations", "repositories", "repo_findings"]) {
      const seen = await as(alice, () => rows(`select user_id from public.${table}`));
      assert.ok(seen.length >= 1, `${table} is empty for its owner`);
      assert.ok(seen.every((r) => r.user_id === alice), `${table} leaked another reader's rows`);
    }
  });

  test("another reader cannot read a private repository's dependency list by asking for it directly", async () => {
    const seen = await as(bob, () => rows("select inventory from public.repositories where id = $1", [aliceRepo]));
    assert.deepEqual(seen, []);
  });

  test("an anonymous visitor sees nothing", async () => {
    for (const table of ["github_installations", "repositories", "repo_findings"]) {
      assert.deepEqual(await as(null, () => rows(`select 1 from public.${table}`)), []);
    }
  });

  test("a reader cannot write to any of it directly, not even their own rows", async () => {
    const insert = await errorCode(() =>
      as(alice, () => db.query("insert into public.repositories (user_id, github_id, full_name) values ($1, 9, 'x/y')", [alice]))
    );
    assert.equal(insert, "42501");

    // An update or delete under RLS with no policy matches no rows: nothing changes.
    await as(alice, () => db.query("update public.repositories set watching = false, health_grade = 'A' where id = $1", [aliceRepo]));
    await as(alice, () => db.query("delete from public.repo_findings where repo_id = $1", [aliceRepo]));
    await as(alice, () => db.query("update public.repo_findings set notified_at = now() where repo_id = $1", [aliceRepo]));
    await as(alice, () => db.query("delete from public.github_installations where user_id = $1", [alice]));

    const [repo] = await rows("select watching, health_grade from public.repositories where id = $1", [aliceRepo]);
    assert.deepEqual([repo.watching, repo.health_grade], [true, null]);
    const [found] = await findings(aliceRepo);
    assert.deepEqual([found.status, found.notified_at], ["open", null]);
    assert.equal((await rows("select 1 from public.github_installations where user_id = $1", [alice])).length, 1);
  });

  test("the shared caches are invisible to every signed-in user", async () => {
    for (const table of ["guard_advisories", "guard_package_status", "guard_cache"]) {
      const seen = await as(alice, () => rows(`select count(*)::int as count from public.${table}`));
      assert.equal(seen[0].count, 0, `${table} leaked to a signed-in user`);
    }
  });

  test("the functions that change scan state cannot be called by a reader or a visitor", async () => {
    const calls = [
      `select public.guard_apply_scan('${aliceRepo}', '[]'::jsonb, '{}'::jsonb)`,
      "select public.guard_mark_notified(array[1]::bigint[])",
      "select * from public.guard_pending_users()",
      "select public.prune_guard_data()",
    ];
    for (const sql of calls) {
      assert.equal(await errorCode(() => as(alice, () => db.query(sql))), "42501", sql);
      assert.equal(await errorCode(() => as(null, () => db.query(sql))), "42501", sql);
    }
    assert.equal((await findings(aliceRepo))[0].status, "open", "nothing was resolved by the refused call");
  });

  test("a background job can call them", async () => {
    const result = await asService(() =>
      rows("select public.guard_apply_scan($1, $2::jsonb, '{}'::jsonb) as result", [aliceRepo, JSON.stringify([finding({ key: "a" })])])
    );
    assert.equal(result[0].result.added, 0);
    assert.ok((await asService(() => rows("select * from public.guard_pending_users()"))).length >= 1);
  });
});

describe("prune_guard_data", () => {
  test("drops long-resolved findings and stale cache rows, and keeps what is current", async () => {
    const repo = await addRepo(await createUser());
    await scan(repo, [{ key: "old" }, { key: "recent" }, { key: "open" }]);
    await scan(repo, [{ key: "open" }]);
    await db.query("update public.repo_findings set resolved_at = now() - interval '200 days' where repo_id = $1 and key = 'old'", [repo]);

    await db.query("insert into public.guard_advisories (id, data, fetched_at) values ('GHSA-stale', '{}', now() - interval '400 days'), ('GHSA-fresh', '{}', now())");
    await db.query("insert into public.guard_package_status (key, checked_at) values ('npm:stale@1', now() - interval '90 days'), ('npm:fresh@1', now())");

    const [{ result }] = await rows("select public.prune_guard_data() as result");
    assert.deepEqual(result, { findings: 1, advisories: 1, package_status: 1 });

    assert.deepEqual((await findings(repo)).map((f) => f.key), ["open", "recent"]);
    assert.deepEqual((await rows("select id from public.guard_advisories where id like 'GHSA-stale' or id like 'GHSA-fresh'")).map((r) => r.id), ["GHSA-fresh"]);
    assert.deepEqual((await rows("select key from public.guard_package_status where key like 'npm:stale%' or key like 'npm:fresh%'")).map((r) => r.key), ["npm:fresh@1"]);
  });
});
