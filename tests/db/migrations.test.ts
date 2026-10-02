import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  applyMigrations,
  as,
  closeDatabase,
  createUser,
  db,
  errorCode,
  migrationFiles,
  openDatabase,
  rows,
} from "./harness";

/**
 * The migrations, run for real, against the Postgres in ./harness.
 */

/** A 768-dimension vector pointing mostly along one axis. */
function axis(index: number, lean: Record<number, number> = {}): string {
  const values = new Array<number>(768).fill(0);
  values[index] = 1;
  for (const [i, v] of Object.entries(lean)) values[Number(i)] = v;
  return `[${values.join(",")}]`;
}

async function addItem(fields: Record<string, unknown>): Promise<string> {
  const row = {
    canonical_url: `https://example.com/${randomUUID()}`,
    url: "https://example.com/x",
    title: "A title",
    status: "enriched",
    summary: "A summary.",
    ...fields,
  };
  const keys = Object.keys(row);
  const [created] = await rows<{ id: string }>(
    `insert into public.content_items (${keys.join(", ")})
     values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row)
  );
  return created.id;
}

before(openDatabase);
after(closeDatabase);

describe("migrations", () => {
  test("there is something to apply", () => {
    assert.ok(migrationFiles().length >= 2);
  });

  test("are idempotent: applying them all a second time changes nothing and does not fail", async () => {
    await applyMigrations();
    const [{ count }] = await rows("select count(*)::int as count from pg_tables where schemaname = 'public'");
    assert.ok(count >= 15, `expected the full schema, found ${count} tables`);
  });

  test("every table in public has row level security switched on", async () => {
    const unprotected = await rows(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`
    );
    assert.deepEqual(unprotected, [], "a table without RLS is readable by anyone holding the anon key");
  });
});

describe("profiles", () => {
  test("a new account gets a profile, with its tokens, from the trigger", async () => {
    const id = await createUser("ada@example.com", { user_name: "ada" });
    const [profile] = await rows("select * from public.profiles where user_id = $1", [id]);

    assert.equal(profile.email, "ada@example.com");
    assert.equal(profile.display_name, "ada");
    assert.equal(profile.onboarded_at, null);
    assert.equal(profile.is_paused, false);
    assert.match(profile.unsubscribe_token, /^[0-9a-f-]{36}$/);
    assert.match(profile.feed_token, /^[0-9a-f-]{36}$/);
    // Two separate secrets: a shared feed URL must not be able to unsubscribe anyone.
    assert.notEqual(profile.unsubscribe_token, profile.feed_token);
  });

  test("an account with no email still gets a profile", async () => {
    const [user] = await rows<{ id: string }>("insert into auth.users default values returning id");
    const [profile] = await rows("select email from public.profiles where user_id = $1", [user.id]);
    assert.equal(profile.email, "");
  });

  test("send_time must be HH:MM", async () => {
    const id = await createUser();
    assert.equal(
      await errorCode(() => db.query("update public.profiles set send_time = 'soon' where user_id = $1", [id])),
      "23514"
    );
  });

  test("deleting the account removes everything attached to it", async () => {
    const id = await createUser();
    await db.query("insert into public.subscriptions (user_id, module) values ($1, 'digest')", [id]);
    const [delivery] = await rows<{ id: string }>(
      "insert into public.deliveries (user_id, dedupe_key, kind) values ($1, $2, 'manual') returning id",
      [id, `manual:${id}:x`]
    );
    await db.query(
      "insert into public.delivery_items (delivery_id, user_id, module, item_type, ref) values ($1, $2, 'digest', 'content', 'c1')",
      [delivery.id, id]
    );
    await db.query("insert into public.feedback (user_id, item_ref, signal) values ($1, 'c1', 1)", [id]);

    await db.query("delete from auth.users where id = $1", [id]);

    for (const table of ["profiles", "subscriptions", "deliveries", "delivery_items", "feedback"]) {
      const [{ count }] = await rows(`select count(*)::int as count from public.${table} where user_id = $1`, [id]);
      assert.equal(count, 0, `${table} still has rows for a deleted account`);
    }
  });
});

describe("row level security", () => {
  let alice: string;
  let bob: string;

  before(async () => {
    alice = await createUser("alice@example.com");
    bob = await createUser("bob@example.com");
    for (const user of [alice, bob]) {
      await db.query("insert into public.subscriptions (user_id, module) values ($1, 'digest')", [user]);
      await db.query("insert into public.deliveries (user_id, dedupe_key, kind) values ($1, $2, 'manual')", [
        user,
        `manual:${user}:rls`,
      ]);
      await db.query("insert into public.feedback (user_id, item_ref, signal) values ($1, 'story', 1)", [user]);
    }
  });

  test("an anonymous visitor reads no profiles at all", async () => {
    const seen = await as(null, () => rows("select email from public.profiles"));
    assert.deepEqual(seen, []);
  });

  test("a signed-in user reads their own profile and nobody else's", async () => {
    const seen = await as(alice, () => rows("select email from public.profiles"));
    assert.deepEqual(seen, [{ email: "alice@example.com" }]);
  });

  test("a user cannot edit another user's profile", async () => {
    await as(alice, () => db.query("update public.profiles set is_paused = true where user_id = $1", [bob]));
    const [profile] = await rows("select is_paused from public.profiles where user_id = $1", [bob]);
    assert.equal(profile.is_paused, false);
  });

  test("a user cannot move their profile onto another account", async () => {
    const code = await as(alice, () =>
      errorCode(() => db.query("update public.profiles set user_id = $1 where user_id = $2", [bob, alice]))
    );
    // Either the row-security check or the primary key rejects it. What matters
    // is that it is rejected.
    assert.ok(code !== null);
  });

  test("a user manages their own subscriptions and cannot create one for someone else", async () => {
    const own = await as(alice, () =>
      errorCode(() => db.query("insert into public.subscriptions (user_id, module) values ($1, 'dev_pulse')", [alice]))
    );
    assert.equal(own, null);

    const foreign = await as(alice, () =>
      errorCode(() => db.query("insert into public.subscriptions (user_id, module) values ($1, 'dev_pulse')", [bob]))
    );
    assert.equal(foreign, "42501", "new row violates row-level security policy");

    const seen = await as(alice, () => rows("select distinct user_id from public.subscriptions"));
    assert.deepEqual(seen, [{ user_id: alice }]);
  });

  test("history is read-only: a user sees their own deliveries and cannot write any", async () => {
    const seen = await as(alice, () => rows("select user_id from public.deliveries"));
    assert.deepEqual(seen, [{ user_id: alice }]);

    const insert = await as(alice, () =>
      errorCode(() =>
        db.query("insert into public.deliveries (user_id, dedupe_key, kind) values ($1, 'forged', 'manual')", [alice])
      )
    );
    assert.equal(insert, "42501");

    // An update with no matching policy affects no rows rather than raising.
    await as(alice, () => db.query("update public.deliveries set status = 'sent' where user_id = $1", [alice]));
    const [delivery] = await rows("select status from public.deliveries where user_id = $1", [alice]);
    assert.equal(delivery.status, "sending");
  });

  test("feedback is readable by its owner only, and writable by nobody directly", async () => {
    const seen = await as(alice, () => rows("select user_id from public.feedback"));
    assert.deepEqual(seen, [{ user_id: alice }]);

    const insert = await as(alice, () =>
      errorCode(() => db.query("insert into public.feedback (user_id, item_ref, signal) values ($1, 'other', -1)", [alice]))
    );
    assert.equal(insert, "42501");
  });

  test("the shared pool is readable when signed in and hidden otherwise", async () => {
    await addItem({ title: "Visible to members" });
    const member = await as(alice, () => rows("select count(*)::int as count from public.content_items"));
    const visitor = await as(null, () => rows("select count(*)::int as count from public.content_items"));
    assert.ok(member[0].count > 0);
    assert.equal(visitor[0].count, 0);
  });

  test("nobody but the service role can write to the shared pool", async () => {
    const code = await as(alice, () =>
      errorCode(() =>
        db.query("insert into public.content_items (canonical_url, url, title) values ('https://x.test/a', 'u', 't')")
      )
    );
    assert.equal(code, "42501");
  });

  test("internal tables are invisible to every signed-in user", async () => {
    await db.query("insert into public.llm_cache (key, task, output) values ($1, 'editor', '{}')", [randomUUID()]);
    await db.query("select public.bump_provider_usage('groq', 'm', current_date, 1, 10)");

    for (const table of ["llm_cache", "provider_usage"]) {
      const seen = await as(alice, () => rows(`select count(*)::int as count from public.${table}`));
      assert.equal(seen[0].count, 0, `${table} leaked to a signed-in user`);
    }
  });

  test("the delivery platform's tables are closed to app users entirely", async () => {
    for (const table of ["platform_tenants", "platform_api_keys", "platform_messages", "platform_delivery_jobs"]) {
      const seen = await as(alice, () => rows(`select count(*)::int as count from public.${table}`));
      assert.equal(seen[0].count, 0);
    }
  });
});

describe("constraints", () => {
  test("one subscription per module per user", async () => {
    const user = await createUser();
    await db.query("insert into public.subscriptions (user_id, module) values ($1, 'learn')", [user]);
    assert.equal(
      await errorCode(() => db.query("insert into public.subscriptions (user_id, module) values ($1, 'learn')", [user])),
      "23505"
    );
  });

  test("unknown modules, frequencies and out-of-range intervals are rejected", async () => {
    const user = await createUser();
    const insert = (columns: string, values: string) => () =>
      db.query(`insert into public.subscriptions (user_id, ${columns}) values ($1, ${values})`, [user]);

    assert.equal(await errorCode(insert("module", "'horoscope'")), "23514");
    assert.equal(await errorCode(insert("module, frequency", "'digest', 'hourly'")), "23514");
    assert.equal(await errorCode(insert("module, frequency, custom_interval_days", "'digest', 'custom', 0")), "23514");
    assert.equal(await errorCode(insert("module, frequency, custom_interval_days", "'digest', 'custom', 91")), "23514");
    assert.equal(await errorCode(insert("module, frequency, custom_interval_days", "'digest', 'custom', 3")), null);
  });

  test("the delivery ledger admits each logical send exactly once", async () => {
    const user = await createUser();
    const key = `scheduled:${user}:2026-10-01`;
    const claim = () =>
      db.query("insert into public.deliveries (user_id, dedupe_key, kind) values ($1, $2, 'scheduled')", [user, key]);

    assert.equal(await errorCode(claim), null);
    assert.equal(await errorCode(claim), "23505", "a second claim for the same slot must collide");
  });

  test("a story is recorded once per delivery, and an article URL is unique in the pool", async () => {
    const user = await createUser();
    const [delivery] = await rows<{ id: string }>(
      "insert into public.deliveries (user_id, dedupe_key, kind) values ($1, $2, 'manual') returning id",
      [user, randomUUID()]
    );
    const seen = () =>
      db.query(
        "insert into public.delivery_items (delivery_id, user_id, module, item_type, ref) values ($1, $2, 'digest', 'content', 'cluster-1')",
        [delivery.id, user]
      );
    assert.equal(await errorCode(seen), null);
    assert.equal(await errorCode(seen), "23505");

    const url = `https://example.com/${randomUUID()}`;
    await addItem({ canonical_url: url });
    assert.equal(await errorCode(() => addItem({ canonical_url: url })), "23505");
  });

  test("feedback keeps one vote per user per story", async () => {
    const user = await createUser();
    await db.query("insert into public.feedback (user_id, item_ref, signal) values ($1, 's', 1)", [user]);
    assert.equal(
      await errorCode(() =>
        db.query("insert into public.feedback (user_id, item_ref, signal) values ($1, 's', -1)", [user])
      ),
      "23505"
    );
    assert.equal(
      await errorCode(() => db.query("insert into public.feedback (user_id, item_ref, signal) values ($1, 't', 5)", [user])),
      "23514",
      "a signal is +1 or -1"
    );
  });
});

describe("existing_items", () => {
  test("returns the rows for URLs already in the pool and nothing for new ones", async () => {
    const known = `https://example.com/${randomUUID()}`;
    await addItem({ canonical_url: known, tags: ["rust"], popularity: JSON.stringify({ hn_points: 120 }), pop_score: 0.7 });

    const found = await rows("select * from public.existing_items($1::text[])", [[known, "https://example.com/never-seen"]]);
    assert.equal(found.length, 1);
    assert.equal(found[0].canonical_url, known);
    assert.deepEqual(found[0].tags, ["rust"]);
    assert.deepEqual(found[0].popularity, { hn_points: 120 });
  });

  test("an empty list is not an error", async () => {
    assert.deepEqual(await rows("select * from public.existing_items('{}'::text[])"), []);
  });
});

describe("clustering", () => {
  test("match_recent_items finds the nearest clustered neighbour and reports its similarity", async () => {
    const [cluster] = await rows<{ id: string }>("insert into public.content_clusters default values returning id");
    const near = await addItem({ title: "Postgres 18 released", embedding: axis(10), cluster_id: cluster.id });
    await addItem({ title: "Something unrelated", embedding: axis(500) });
    const probe = await addItem({ title: "PostgreSQL 18 is out", embedding: axis(10, { 11: 0.2 }) });

    const matches = await rows(
      "select * from public.match_recent_items($1::extensions.halfvec, now() - interval '4 days', $2, 3)",
      [axis(10, { 11: 0.2 }), probe]
    );

    assert.equal(matches[0].id, near);
    assert.equal(matches[0].cluster_id, cluster.id);
    assert.ok(matches[0].similarity > 0.95, `similarity ${matches[0].similarity}`);
    assert.ok(!matches.some((m) => m.id === probe), "an item must never match itself");
    assert.ok(matches[matches.length - 1].similarity < 0.3);
  });

  test("items outside the time window are not candidates", async () => {
    const old = await addItem({ embedding: axis(20), published_at: "2020-01-01T00:00:00Z" });
    const matches = await rows(
      "select id from public.match_recent_items($1::extensions.halfvec, now() - interval '4 days', $2, 50)",
      [axis(20), randomUUID()]
    );
    assert.ok(!matches.some((m) => m.id === old));
  });

  test("touch_cluster counts another article joining the story", async () => {
    const [cluster] = await rows<{ id: string }>("insert into public.content_clusters default values returning id");
    await db.query("select public.touch_cluster($1)", [cluster.id]);
    await db.query("select public.touch_cluster($1)", [cluster.id]);
    const [after] = await rows("select item_count from public.content_clusters where id = $1", [cluster.id]);
    assert.equal(after.item_count, 3);
  });
});

describe("digest_candidates", () => {
  const since = "now() - interval '7 days'";

  test("returns items that share a tag, with the source's quality joined in", async () => {
    const tag = `t${randomUUID().slice(0, 8)}`;
    await db.query(
      "insert into public.sources (id, kind, name, url, quality) values ($1, 'rss', 'A Source', 'https://s.test/feed', 0.9)",
      [`rss:${tag}`]
    );
    const tagged = await addItem({ tags: [tag], source_id: `rss:${tag}`, pop_score: 0.5 });
    await addItem({ tags: ["something-else"] });

    const found = await rows(`select * from public.digest_candidates($1::text[], null, ${since}, 50)`, [[tag]]);
    assert.deepEqual(found.map((f) => f.id), [tagged]);
    assert.ok(Math.abs(found[0].source_quality - 0.9) < 1e-6);
    assert.equal(found[0].similarity, null, "no reader vector, so no similarity");
  });

  test("leaves out anything not ready to be read", async () => {
    const tag = `t${randomUUID().slice(0, 8)}`;
    const ready = await addItem({ tags: [tag] });
    await addItem({ tags: [tag], status: "new" });
    await addItem({ tags: [tag], status: "rejected" });
    await addItem({ tags: [tag], summary: null });
    await addItem({ tags: [tag], published_at: "2020-01-01T00:00:00Z" });

    const found = await rows(`select id from public.digest_candidates($1::text[], null, ${since}, 50)`, [[tag]]);
    assert.deepEqual(found.map((f) => f.id), [ready]);
  });

  test("a reader's vector surfaces an untagged article, with its similarity", async () => {
    const tag = `t${randomUUID().slice(0, 8)}`;
    const close = await addItem({ tags: [], embedding: axis(300) });
    const far = await addItem({ tags: [], embedding: axis(301) });

    const found = await rows(
      `select id, similarity from public.digest_candidates($1::text[], $2::extensions.halfvec, ${since}, 1)`,
      [[tag], axis(300)]
    );
    const ids = found.map((f) => f.id);
    assert.ok(ids.includes(close));
    assert.ok(!ids.includes(far), "the limit applies to the vector side too");
    assert.ok(found.find((f) => f.id === close)!.similarity > 0.99);
  });

  test("an article matched by both tag and vector appears once", async () => {
    const tag = `t${randomUUID().slice(0, 8)}`;
    const both = await addItem({ tags: [tag], embedding: axis(400) });
    const found = await rows(
      `select id from public.digest_candidates($1::text[], $2::extensions.halfvec, ${since}, 50)`,
      [[tag], axis(400)]
    );
    assert.equal(found.filter((f) => f.id === both).length, 1);
  });
});

describe("provider usage", () => {
  test("bump_provider_usage accumulates per provider, model and day", async () => {
    const model = `m-${randomUUID()}`;
    await db.query("select public.bump_provider_usage('groq', $1, '2026-10-01', 1, 100)", [model]);
    await db.query("select public.bump_provider_usage('groq', $1, '2026-10-01', 2, 250)", [model]);
    await db.query("select public.bump_provider_usage('groq', $1, '2026-10-02', 1, 5)", [model]);

    const usage = await rows(
      "select day::text, requests, tokens from public.provider_usage where model = $1 order by day",
      [model]
    );
    assert.deepEqual(usage, [
      { day: "2026-10-01", requests: 3, tokens: 350 },
      { day: "2026-10-02", requests: 1, tokens: 5 },
    ]);
  });
});

describe("prune_old_data", () => {
  test("drops stale content and empty clusters, and keeps the memory of what was sent", async () => {
    const user = await createUser();
    const [staleCluster] = await rows<{ id: string }>("insert into public.content_clusters default values returning id");
    const [liveCluster] = await rows<{ id: string }>("insert into public.content_clusters default values returning id");

    const stale = await addItem({ cluster_id: staleCluster.id, published_at: "2026-01-01T00:00:00Z" });
    const fresh = await addItem({ cluster_id: liveCluster.id });

    const [oldDelivery] = await rows<{ id: string }>(
      `insert into public.deliveries (user_id, dedupe_key, kind, status, payload, created_at)
       values ($1, $2, 'scheduled', 'sent', '{"subject":"old"}', now() - interval '200 days') returning id`,
      [user, randomUUID()]
    );
    const [newDelivery] = await rows<{ id: string }>(
      `insert into public.deliveries (user_id, dedupe_key, kind, status, payload)
       values ($1, $2, 'scheduled', 'sent', '{"subject":"new"}') returning id`,
      [user, randomUUID()]
    );
    await db.query(
      "insert into public.delivery_items (delivery_id, user_id, module, item_type, ref) values ($1, $2, 'digest', 'content', $3)",
      [oldDelivery.id, user, staleCluster.id]
    );

    const [{ report }] = await rows("select public.prune_old_data(60) as report");
    assert.ok(report.content_items >= 1);
    assert.ok(report.clusters >= 1);

    const remaining = await rows("select id from public.content_items where id = any($1::uuid[])", [[stale, fresh]]);
    assert.deepEqual(remaining.map((r) => r.id), [fresh]);

    const clusters = await rows("select id from public.content_clusters where id = any($1::uuid[])", [
      [staleCluster.id, liveCluster.id],
    ]);
    assert.deepEqual(clusters.map((c) => c.id), [liveCluster.id]);

    const payloads = await rows("select id, payload from public.deliveries where id = any($1::uuid[]) order by created_at", [
      [oldDelivery.id, newDelivery.id],
    ]);
    assert.equal(payloads[0].payload, null, "an old issue keeps its row but not its body");
    assert.deepEqual(payloads[1].payload, { subject: "new" });

    // The article is gone, but the reader must still never be shown that story again.
    const seen = await rows("select ref from public.delivery_items where user_id = $1", [user]);
    assert.deepEqual(seen, [{ ref: staleCluster.id }]);
  });
});

describe("delivery platform", () => {
  test("enqueue_message is idempotent on the caller's key", async () => {
    const [tenant] = await rows<{ id: string }>(
      "insert into public.platform_tenants (name) values ('test') returning id"
    );
    const enqueue = () =>
      rows(
        `select * from public.enqueue_message($1, 'key-1', 'Reader@Example.com', 'from@example.com',
                                              'Subject', '<p>hi</p>', 'hi', null)`,
        [tenant.id]
      );

    const [first] = await enqueue();
    const [second] = await enqueue();

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.message_id, first.message_id);

    const jobs = await rows("select count(*)::int as count from public.platform_delivery_jobs where message_id = $1", [
      first.message_id,
    ]);
    assert.equal(jobs[0].count, 1, "a replayed request must not queue a second delivery");
  });
});
