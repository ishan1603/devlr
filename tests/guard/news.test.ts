import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { lintProse, lintSubject, SUBJECT_MAX_LENGTH } from "@/lib/ai/style";
import { shareable, type GuardSection, type Issue, type StoriesSection } from "@/lib/delivery/issue";
import { inventedNumbers, isGrounded, templateCopy } from "@/lib/delivery/editor";
import { evaluateDue, type ScheduleSubscription } from "@/lib/delivery/schedule";
import { renderIssueHtml, renderIssueText } from "@/lib/email/render";
import { badgeText, renderBadge } from "@/lib/guard/badge";
import { buildGuardNews, guardCopy, guardHeadline, type GuardRepo, type PendingFinding } from "@/lib/guard/news";
import { packInventory, unpackInventory } from "@/lib/guard/pack";
import type { PackageReport } from "@/lib/guard/rollup";
import type { Finding, Inventory } from "@/lib/guard/types";
import { badgeMarkdown, countsLabel, runtimeName, sourceLabel, timeAgo } from "@/lib/guard/view";

/**
 * What a reader is told, and when.
 *
 * "Tell me once" is decided in two places: the database remembers which
 * findings were announced (tests/db/guard.test.ts), and the code here decides
 * what to say about the ones that were not. Between them they have to hold a
 * line that is easy to state and easy to break: everything new is announced,
 * and nothing is announced twice.
 */

const BASE = "https://devlr.example";

const finding = (key: string, over: Partial<Finding> = {}): Finding => ({
  key,
  kind: "vulnerability",
  priority: "high",
  score: 62,
  ecosystem: "npm",
  package: "next",
  version: "15.4.5",
  severity: "high",
  title: "next 15.4.5: Something breaks",
  summary: "Something breaks.",
  ...over,
});

const entry = (over: Partial<PackageReport> = {}): PackageReport => ({
  key: "npm:next",
  kind: "vulnerability",
  priority: "high",
  score: 62,
  title: "next 15.4.5 has 2 known vulnerabilities (2 high)",
  action: "Upgrade to 15.5.24. That clears all 2.",
  command: "npm install next@15.5.24",
  ecosystem: "npm",
  package: "next",
  versions: ["15.4.5"],
  direct: true,
  scope: "runtime",
  severities: { high: 2 },
  kev: false,
  findings: [finding("v:next:1"), finding("v:next:2")],
  ...over,
});

const repo = (over: Partial<GuardRepo> = {}): GuardRepo => ({
  id: "repo-1",
  fullName: "acme/web",
  grade: "D",
  score: 55,
  report: [entry()],
  ...over,
});

let nextId = 0;
const pending = (key: string, over: Partial<PendingFinding> = {}): PendingFinding => ({
  id: ++nextId,
  repoId: "repo-1",
  key,
  urgent: false,
  ...over,
});

const news = (repos: GuardRepo[], waiting: PendingFinding[], urgentOnly = false) =>
  buildGuardNews(repos, waiting, { urgentOnly, baseUrl: BASE });

describe("guardHeadline", () => {
  test("says which package, where, and how bad", () => {
    assert.equal(
      guardHeadline(entry({ severities: { critical: 1, high: 2 }, findings: [finding("a"), finding("b"), finding("c")] }), "acme/web"),
      "next 15.4.5 in acme/web: 3 advisories, 1 critical"
    );
    assert.equal(
      guardHeadline(entry({ severities: { critical: 1 }, findings: [finding("a")] }), "acme/web"),
      "next 15.4.5 in acme/web: critical advisory"
    );
  });

  test("active exploitation is the headline when there is any", () => {
    assert.equal(guardHeadline(entry({ kev: true }), "acme/web"), "next 15.4.5 in acme/web is being exploited");
  });

  test("malware, deprecations and things that are not packages each read naturally", () => {
    assert.equal(guardHeadline(entry({ kind: "malicious", package: "evil-pkg", findings: [finding("m", { kind: "malicious", version: "1.0.0" })] }), "acme/web"), "evil-pkg 1.0.0 in acme/web is known malware");
    assert.equal(
      guardHeadline(entry({ kind: "deprecated", package: "request", findings: [finding("d", { kind: "deprecated", version: "2.88.2" })] }), "acme/web"),
      "request 2.88.2 in acme/web is deprecated"
    );
    const eol = entry({ kind: "eol", package: undefined, ecosystem: undefined, title: "Node.js 20 reached end of life on 2026-04-30" });
    assert.equal(guardHeadline(eol, "acme/web"), "Node.js 20 reached end of life on 2026-04-30 (acme/web)");
    const unresolved = entry({ kind: "unresolved", package: undefined, ecosystem: undefined, title: "2 dependencies in go.mod could not be checked" });
    assert.equal(guardHeadline(unresolved, "acme/web"), "acme/web: 2 dependencies in go.mod could not be checked");
  });

  test("a long repository name loses its owner before the line loses its meaning", () => {
    const many = entry({ severities: { critical: 3, high: 13 }, findings: Array.from({ length: 31 }, (_, i) => finding(`f${i}`)) });
    const line = guardHeadline(many, "ada-lovelace/storefront");
    assert.equal(line, "next 15.4.5 in storefront: 31 advisories, 3 critical");
    assert.ok(line.length <= SUBJECT_MAX_LENGTH);
  });

  test("when even that is too long, the repository goes and the fact stays", () => {
    const many = entry({ severities: { critical: 3, high: 13 }, findings: Array.from({ length: 31 }, (_, i) => finding(`f${i}`)) });
    assert.equal(
      guardHeadline(many, "some-organisation/a-very-long-service-name"),
      "next 15.4.5: 31 advisories, 3 critical"
    );
  });

  test("a package name that fills the line on its own still ends on a whole fact", () => {
    const long = entry({
      package: "@opentelemetry/auto-instrumentations-node",
      severities: { high: 4 },
      findings: [finding("a", { version: "0.56.1" }), finding("b"), finding("c"), finding("d")],
    });
    assert.equal(guardHeadline(long, "acme/web"), "@opentelemetry/auto-instrumentations-node: 4 advisories");
  });

  test("never ends mid-fact, whatever the names", () => {
    for (const name of ["a/b", "organisation/repository", "x".repeat(30) + "/" + "y".repeat(40)]) {
      const line = guardHeadline(entry({ severities: { critical: 3, high: 13 }, findings: Array.from({ length: 31 }, (_, i) => finding(`f${i}`)) }), name);
      assert.ok(line.length <= SUBJECT_MAX_LENGTH, line);
      assert.match(line, /(critical|advisories)$/, line);
    }
  });
});

describe("buildGuardNews", () => {
  test("nothing waiting, nothing to say", () => {
    assert.deepEqual(news([repo()], []), { section: null, refs: [], findingIds: [] });
  });

  test("a package with an unannounced finding is news, and all its waiting findings are settled", () => {
    const waiting = [pending("v:next:1"), pending("v:next:2")];
    const result = news([repo()], waiting);

    assert.equal(result.section!.entries.length, 1);
    const [shown] = result.section!.entries;
    assert.equal(shown.ref, "repo-1:npm:next");
    assert.equal(shown.repo, "acme/web");
    assert.equal(shown.title, "next 15.4.5 has 2 known vulnerabilities (2 high)");
    assert.equal(shown.command, "npm install next@15.5.24");
    assert.equal(shown.url, `${BASE}/app/repos/repo-1`, "several advisories: the link is the repo's page");
    assert.deepEqual(shown.meta, ["direct"]);
    assert.deepEqual(result.refs, ["repo-1:npm:next"]);
    assert.deepEqual(result.findingIds.sort(), waiting.map((p) => p.id).sort());
  });

  test("a package whose findings were all announced stays quiet", () => {
    const quiet = entry({ key: "npm:ws", package: "ws", findings: [finding("v:ws:1")] });
    const result = news([repo({ report: [entry(), quiet] })], [pending("v:next:1")]);
    assert.deepEqual(result.section!.entries.map((e) => e.ref), ["repo-1:npm:next"]);
  });

  test("one new advisory on a package announced before says how many are new", () => {
    const result = news([repo()], [pending("v:next:2")]);
    assert.deepEqual(result.section!.entries[0].meta, ["direct", "1 new"]);
  });

  test("a single advisory links straight to its own page", () => {
    const single = entry({ url: "https://github.com/advisories/GHSA-1", findings: [finding("v:next:1")] });
    assert.equal(news([repo({ report: [single] })], [pending("v:next:1")]).section!.entries[0].url, "https://github.com/advisories/GHSA-1");
  });

  test("transitive, dev-only and exploited are said in the meta line", () => {
    const nested = entry({ direct: false, scope: "dev", kev: true });
    assert.deepEqual(news([repo({ report: [nested] })], [pending("v:next:1"), pending("v:next:2")]).section!.entries[0].meta, [
      "transitive, dev only",
      "exploited in the wild",
    ]);
  });

  test("most pressing first, across repositories", () => {
    const api = repo({
      id: "repo-2",
      fullName: "acme/api",
      report: [entry({ key: "npm:ws", package: "ws", priority: "urgent", score: 90, findings: [finding("v:ws:1")] })],
    });
    const result = news([repo(), api], [pending("v:next:1"), pending("v:ws:1", { repoId: "repo-2" })]);
    assert.deepEqual(result.section!.entries.map((e) => `${e.priority} ${e.repo}`), ["urgent acme/api", "high acme/web"]);
  });

  test("a regular issue shows three in full and names the rest, and settles all of them", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const report = names.map((name, i) =>
      entry({ key: `npm:${name}`, package: name, score: 90 - i, findings: [finding(`v:${name}`)] })
    );
    const waiting = names.map((name) => pending(`v:${name}`));
    const result = news([repo({ report })], waiting);

    assert.deepEqual(result.section!.entries.map((e) => e.ref), ["repo-1:npm:a", "repo-1:npm:b", "repo-1:npm:c"]);
    assert.deepEqual(result.section!.also, ["d", "e", "f"]);
    assert.equal(result.refs.length, 6);
    assert.equal(result.findingIds.length, 6, "named only is still told");
  });

  test("a long tail is counted, not listed", () => {
    const report = Array.from({ length: 15 }, (_, i) =>
      entry({ key: `npm:p${i}`, package: `p${i}`, score: 90 - i, findings: [finding(`v:p${i}`)] })
    );
    const result = news([repo({ report })], report.map((e) => pending(e.findings[0].key)));
    assert.equal(result.section!.also.length, 9);
    assert.equal(result.section!.also.at(-1), "4 more");
  });

  test("the section carries each repository's health, worst first", () => {
    const healthy = repo({ id: "repo-2", fullName: "acme/api", grade: "B", score: 82, report: [entry({ key: "npm:ws", package: "ws", findings: [finding("v:ws:1")] })] });
    const result = news([healthy, repo()], [pending("v:next:1"), pending("v:ws:1", { repoId: "repo-2" })]);
    assert.deepEqual(result.section!.repos, [
      { fullName: "acme/web", grade: "D", score: 55, toFix: 1, url: `${BASE}/app/repos/repo-1` },
      { fullName: "acme/api", grade: "B", score: 82, toFix: 1, url: `${BASE}/app/repos/repo-2` },
    ]);
    assert.equal(result.section!.url, `${BASE}/app/repos`);
  });

  test("a repository with nothing waiting is not mentioned", () => {
    const other = repo({ id: "repo-2", fullName: "acme/api" });
    const result = news([repo(), other], [pending("v:next:1")]);
    assert.deepEqual(result.section!.repos.map((r) => r.fullName), ["acme/web"]);
  });

  test("a waiting finding that no report shows any more is settled rather than left to come back", () => {
    const stale = pending("v:gone:1");
    const quiet = news([repo()], [stale]);
    assert.equal(quiet.section, null);
    assert.deepEqual(quiet.findingIds, [stale.id]);

    const real = pending("v:next:1");
    const mixed = news([repo()], [stale, real]);
    assert.deepEqual(mixed.findingIds.sort(), [stale.id, real.id].sort());
  });

  test("a finding in a repository that was not loaded is left alone", () => {
    const elsewhere = pending("v:next:1", { repoId: "not-watched" });
    assert.deepEqual(news([repo()], [elsewhere]).findingIds, []);
  });

  describe("the alert", () => {
    const urgent = entry({
      key: "npm:next",
      priority: "urgent",
      score: 89,
      findings: [finding("v:next:1", { priority: "urgent" }), finding("v:next:2"), finding("v:next:3")],
    });
    const calm = entry({ key: "npm:ws", package: "ws", findings: [finding("v:ws:1")] });

    test("only shows a package with something urgent the reader has not been told is urgent", () => {
      const waiting = [pending("v:next:1", { urgent: true }), pending("v:next:2"), pending("v:ws:1")];
      const result = news([repo({ report: [urgent, calm] })], waiting, true);
      assert.deepEqual(result.section!.entries.map((e) => e.ref), ["repo-1:npm:next"]);
      assert.equal(result.section!.title, "Needs fixing now");
    });

    test("announces that package whole, so its calmer advisories do not come again tomorrow", () => {
      const a = pending("v:next:1", { urgent: true });
      const b = pending("v:next:2");
      const c = pending("v:next:3");
      const other = pending("v:ws:1");
      const result = news([repo({ report: [urgent, calm] })], [a, b, c, other], true);
      assert.deepEqual(result.findingIds.sort(), [a.id, b.id, c.id].sort());
      assert.ok(!result.findingIds.includes(other.id), "what the alert does not show waits for the regular issue");
      assert.deepEqual(result.section!.entries[0].meta, ["direct"], "all of it is new, so nothing to qualify");
    });

    test("with nothing urgent waiting there is no alert", () => {
      const result = news([repo({ report: [urgent, calm] })], [pending("v:next:2"), pending("v:ws:1")], true);
      assert.deepEqual(result, { section: null, refs: [], findingIds: [] });
    });

    test("an urgent finding that no report shows any more is settled, or every scan would raise it again", () => {
      const ghost = pending("v:gone:1", { urgent: true });
      const result = news([repo({ report: [calm] })], [ghost, pending("v:ws:1")], true);
      assert.equal(result.section, null);
      assert.deepEqual(result.findingIds, [ghost.id]);
    });

    test("shows up to five in full", () => {
      const report = Array.from({ length: 7 }, (_, i) =>
        entry({ key: `npm:p${i}`, package: `p${i}`, priority: "urgent", score: 99 - i, findings: [finding(`v:p${i}`, { priority: "urgent" })] })
      );
      const result = news([repo({ report })], report.map((e) => pending(e.findings[0].key, { urgent: true })), true);
      assert.equal(result.section!.entries.length, 5);
      assert.deepEqual(result.section!.also, ["p5", "p6"]);
    });
  });
});

describe("guardCopy", () => {
  const section = (over: Partial<GuardSection> = {}): GuardSection => {
    const built = news([repo()], [pending("v:next:1"), pending("v:next:2")]).section!;
    return { ...built, ...over };
  };

  test("the subject is the lead entry's headline, and passes the same rules as any other subject", () => {
    const copy = guardCopy(section(), false);
    assert.equal(copy.subject, "next 15.4.5 in acme/web: 2 advisories, 2 high");
    assert.deepEqual(lintSubject(copy.subject), []);
  });

  test("the preheader is the first step of the advice", () => {
    assert.equal(guardCopy(section(), false).preheader, "Upgrade to 15.5.24.");
  });

  test("with more below, the preheader says so", () => {
    const more = section({ also: ["ws", "tar"] });
    assert.equal(guardCopy(more, false).preheader, "Upgrade to 15.5.24. Plus 2 more below.");
  });

  test("the intro counts what needs attention, and where", () => {
    assert.equal(guardCopy(section(), false).intro, "One thing needs attention in acme/web.");
    assert.equal(guardCopy(section({ also: ["ws", "tar"] }), false).intro, "3 things need attention in acme/web. Most pressing first.");
  });

  test("several repositories are counted rather than named", () => {
    const base = section();
    const two = section({ entries: [base.entries[0], { ...base.entries[0], ref: "x", repo: "acme/api" }] });
    assert.equal(guardCopy(two, false).intro, "2 things need attention in 2 repositories. Most pressing first.");
  });

  test("the alert says why it did not wait, and whether the fix is a command", () => {
    assert.equal(
      guardCopy(section(), true).intro,
      "This was found in acme/web and should not wait for your next issue. The fix is a command you can paste."
    );
    const base = section();
    const noCommand = section({ entries: [{ ...base.entries[0], command: undefined }], also: ["ws"] });
    assert.equal(
      guardCopy(noCommand, true).intro,
      "These were found in acme/web and should not wait for your next issue. What to do is below."
    );
  });

  test("none of it trips the style guard, and none of it shouts", () => {
    for (const urgent of [true, false]) {
      const copy = guardCopy(section({ also: ["ws"] }), urgent);
      assert.deepEqual(lintSubject(copy.subject), []);
      assert.deepEqual(lintProse(copy.preheader), []);
      assert.deepEqual(lintProse(copy.intro), []);
      assert.doesNotMatch(`${copy.subject} ${copy.preheader} ${copy.intro}`, /\burgent\b|act now|!/i);
    }
  });

  test("a version number is not mistaken for the end of a sentence", () => {
    const base = section();
    const versioned = section({ entries: [{ ...base.entries[0], action: "Upgrade to 15.5.24, which fixes 1 of 2. The other still applies at that version." }] });
    assert.equal(guardCopy(versioned, false).preheader, "Upgrade to 15.5.24, which fixes 1 of 2.");
  });
});

describe("Repo Guard in an issue", () => {
  const guard = news([repo()], [pending("v:next:1"), pending("v:next:2")]).section!;
  const stories: StoriesSection = {
    type: "stories",
    module: "digest",
    label: "news",
    title: "News",
    items: [
      {
        ref: "cluster-1",
        canonicalUrl: "https://example.com/pg18",
        url: "https://example.com/pg18",
        title: "Postgres 18 ships asynchronous I/O",
        summary: "Postgres 18 adds asynchronous I/O.",
        source: "PostgreSQL News",
        site: "postgresql.org",
        kind: "release",
        tags: ["postgres"],
        meta: [],
        alsoCoveredBy: [],
        feedback: { more: "https://devlr.example/f/more", less: "https://devlr.example/f/less" },
      },
    ],
  };
  const issue: Issue = {
    subject: "next 15.4.5 in acme/web: 2 advisories, 2 high",
    preheader: "Upgrade to 15.5.24. Also: Postgres 18 ships asynchronous I/O",
    intro: "Postgres 18 is out.",
    date: "2026-10-01T08:00:00.000Z",
    sections: [guard, stories],
    aiEdited: false,
  };
  const links = { web: `${BASE}/issue/x`, preferences: `${BASE}/app/topics`, unsubscribe: `${BASE}/u` };

  test("the plain-text part has the finding, the advice and the command", () => {
    const text = renderIssueText({ issue, links });
    assert.match(text, /\/\/ repo guard/);
    assert.match(text, /acme\/web {2}D 55\/100, 1 to fix/);
    assert.match(text, /\[high\] acme\/web\nnext 15\.4\.5 has 2 known vulnerabilities \(2 high\)\ndirect\nUpgrade to 15\.5\.24\. That clears all 2\.\n\$ npm install next@15\.5\.24/);
    assert.match(text, new RegExp(`Every finding: ${BASE}/app/repos`));
  });

  test("the HTML part has them too, with no dashes that are not hyphens", async () => {
    const html = await renderIssueHtml({ issue, links, recipient: "ada@example.com" });
    assert.match(html, /npm install next@15\.5\.24/);
    assert.match(html, /\[<!-- -->high<!-- -->\]|\[high\]/);
    assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
    assert.doesNotMatch(html, /[–—]/);
  });

  test("the lead story keeps its large type when Repo Guard comes first", async () => {
    const html = await renderIssueHtml({ issue, links, recipient: "ada@example.com" });
    assert.match(html, /class="d-ink m-lead"[^>]*>\s*<a[^>]*>Postgres 18 ships/);
  });

  test("the editor treats it as source material: its numbers are not inventions, and its words ground a subject", () => {
    assert.deepEqual(inventedNumbers("next 15.4.5 needs 15.5.24, which clears 2", issue.sections), []);
    assert.deepEqual(inventedNumbers("next 16.1 is out", issue.sections), ["16.1"]);
    assert.equal(isGrounded("next in acme web has known vulnerabilities", [guard]), true);
  });

  test("with no model, an issue that is only Repo Guard still gets specific copy", () => {
    const copy = templateCopy({ sections: [guard], interests: [], previousIntros: [], date: new Date("2026-10-01T08:00:00Z") });
    assert.equal(copy.subject, "next 15.4.5 in acme/web: 2 advisories, 2 high");
    assert.equal(copy.intro, "One thing needs attention in acme/web.");
    assert.equal(copy.aiEdited, false);
  });

  describe("on a page that opens with a link alone", () => {
    const copy = shareable(issue);

    test("what was found is removed, and so are the reader's feedback links", () => {
      const section = copy.sections[0] as GuardSection;
      assert.deepEqual([section.entries, section.repos, section.also, section.redacted], [[], [], [], true]);
      assert.equal((copy.sections[1] as StoriesSection).items[0].feedback, undefined);
    });

    test("the subject and preheader, which name the package and the repo, are replaced", () => {
      assert.equal(copy.subject, "Repo Guard has something for you");
      assert.doesNotMatch(`${copy.subject} ${copy.preheader}`, /next|acme|15\.5\.24/);
      assert.equal(copy.intro, "Postgres 18 is out.", "the intro was about the reading, so it stays");
    });

    test("an alert, which is about nothing else, loses its intro as well", () => {
      const alert = shareable({ ...issue, intro: "This was found in acme/web.", sections: [guard] });
      assert.equal(alert.intro, "");
    });

    test("nothing identifying survives in either rendering", async () => {
      const text = renderIssueText({ issue: copy, links });
      const html = await renderIssueHtml({ issue: copy, links, recipient: "you" });
      for (const rendered of [text, html]) {
        assert.doesNotMatch(rendered, /acme\/web|15\.4\.5|15\.5\.24|npm install/);
      }
      assert.match(html, /Open Repo Guard/);
    });

    test("the original is untouched", () => {
      assert.equal((issue.sections[0] as GuardSection).entries.length, 1);
      assert.equal(issue.subject, "next 15.4.5 in acme/web: 2 advisories, 2 high");
    });

    test("an issue with no Repo Guard keeps its own subject", () => {
      const plain = shareable({ ...issue, subject: "Postgres 18 ships", sections: [stories] });
      assert.equal(plain.subject, "Postgres 18 ships");
    });
  });
});

describe("scheduling: Repo Guard only triggers a send when it has news", () => {
  const profile = { user_id: "u", timezone: "UTC", send_time: "08:00", is_paused: false, onboarded_at: "2026-09-01T00:00:00Z" };
  const sub = (over: Partial<ScheduleSubscription>): ScheduleSubscription => ({
    module: "repo_guard",
    is_active: true,
    frequency: "daily",
    custom_interval_days: null,
    last_sent_at: null,
    ...over,
  });
  const NOW = new Date("2026-10-01T09:00:00Z");
  const withNews = new Set(["repo_guard" as const]);

  test("due, but nothing new: no email", () => {
    const verdict = evaluateDue(profile, [sub({})], NOW);
    assert.deepEqual([verdict.due, verdict.reason], [false, "nothing due"]);
  });

  test("due, with news: an email", () => {
    const verdict = evaluateDue(profile, [sub({})], NOW, withNews);
    assert.deepEqual([verdict.due, verdict.modules], [true, ["repo_guard"]]);
  });

  test("news does not override the cadence: a weekly reader told yesterday waits", () => {
    const verdict = evaluateDue(profile, [sub({ frequency: "weekly", last_sent_at: "2026-09-30T08:00:00Z" })], NOW, withNews);
    assert.equal(verdict.due, false);
  });

  test("with no news it still rides along when something else is going out", () => {
    const verdict = evaluateDue(profile, [sub({}), sub({ module: "digest" })], NOW);
    assert.deepEqual([verdict.due, verdict.modules], [true, ["repo_guard", "digest"]]);
  });

  test("news for Repo Guard does not make a module that is not due go out", () => {
    const digest = sub({ module: "digest", frequency: "weekly", last_sent_at: "2026-09-30T08:00:00Z" });
    const verdict = evaluateDue(profile, [sub({}), digest], NOW, withNews);
    assert.deepEqual(verdict.modules, ["repo_guard"]);
  });
});

describe("packInventory", () => {
  const inventory: Inventory = {
    method: "both",
    manifests: ["package-lock.json", "GitHub dependency graph"],
    notes: ["a note"],
    dependencies: [
      { ecosystem: "npm", name: "next", version: "16.3.8", pinned: true, direct: true, scope: "runtime", manifest: "package-lock.json" },
      { ecosystem: "npm", name: "typescript", version: "5.9.3", pinned: true, direct: true, scope: "dev", manifest: "package-lock.json" },
      { ecosystem: "npm", name: "ms", version: "2.1.3", pinned: true, direct: false, scope: "unknown", manifest: "apps/web/package-lock.json" },
      { ecosystem: "GitHub Actions", name: "actions/checkout", version: "6.*.*", pinned: false, direct: true, scope: "unknown" },
    ],
  };

  test("round-trips exactly", () => {
    assert.deepEqual(unpackInventory(packInventory(inventory)), inventory);
  });

  test("survives being stored as JSON", () => {
    assert.deepEqual(unpackInventory(JSON.parse(JSON.stringify(packInventory(inventory)))), inventory);
  });

  test("each lockfile path is stored once, however many packages came from it", () => {
    const packed = packInventory(inventory);
    assert.deepEqual(packed.files, ["package-lock.json", "apps/web/package-lock.json"]);
    assert.deepEqual(packed.deps[0], ["npm", "next", "16.3.8", 1 | 2 | 8, 0]);
    assert.deepEqual(packed.deps[3], ["GitHub Actions", "actions/checkout", "6.*.*", 2, -1]);
  });

  test("is a good deal smaller than the list it packs", () => {
    const big: Inventory = {
      ...inventory,
      dependencies: Array.from({ length: 600 }, (_, i) => ({ ...inventory.dependencies[0], name: `package-${i}` })),
    };
    const packed = JSON.stringify(packInventory(big)).length;
    const plain = JSON.stringify(big).length;
    assert.ok(packed < plain * 0.4, `${packed} vs ${plain}`);
  });

  test("anything that is not a packed inventory comes back as null, so the repo is read again", () => {
    for (const value of [null, undefined, {}, { v: 2, deps: [] }, { v: 1 }, "text", []]) {
      assert.equal(unpackInventory(value), null);
    }
  });
});

describe("the README badge", () => {
  test("shows the grade and score, in the grade's colour", () => {
    assert.deepEqual(badgeText({ grade: "A", score: 94 }), {
      message: "deps A 94/100",
      description: "Dependency health: grade A, 94 out of 100, checked by Devlr",
      colour: "#3f7d20",
    });
    assert.equal(badgeText({ grade: "F", score: 0 }).message, "deps F 0/100");
    assert.notEqual(badgeText({ grade: "F", score: 0 }).colour, badgeText({ grade: "A", score: 94 }).colour);
  });

  test("without a grade it says why, in grey", () => {
    assert.equal(badgeText({}).message, "deps pending");
    assert.equal(badgeText({ status: "not found" }).message, "deps not found");
    assert.equal(badgeText({ grade: "Z", score: 50 }).message, "deps pending", "an unknown grade is not shown as one");
    assert.equal(badgeText({ grade: "A", score: null }).colour, "#6b6b75");
  });

  test("is a well-formed SVG with a text alternative", () => {
    const svg = renderBadge({ grade: "B", score: 82 });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20" role="img" aria-label="Dependency health: grade B, 82 out of 100, checked by Devlr">/);
    assert.match(svg, /<title>Dependency health: grade B/);
    assert.match(svg, />devlr<\/text>/);
    assert.match(svg, />deps B 82\/100<\/text>/);
    assert.ok(svg.endsWith("</svg>"));
    assert.equal((svg.match(/<text /g) ?? []).length, 2);
  });

  test("never says what is wrong", () => {
    const svg = renderBadge({ grade: "F", score: 0 });
    assert.doesNotMatch(svg, /vulnerab|critical|urgent|CVE|GHSA/i);
  });

  test("escapes whatever status it is given", () => {
    const svg = renderBadge({ status: '<script>"&' });
    assert.doesNotMatch(svg, /<script>/);
    assert.match(svg, /&lt;script&gt;&quot;&amp;/);
  });
});

describe("view helpers", () => {
  const now = new Date("2026-10-01T08:00:00Z");

  test("timeAgo is coarse and readable", () => {
    assert.equal(timeAgo("2026-10-01T07:59:30Z", now), "just now");
    assert.equal(timeAgo("2026-10-01T07:40:00Z", now), "20 minutes ago");
    assert.equal(timeAgo("2026-10-01T07:00:00Z", now), "an hour ago");
    assert.equal(timeAgo("2026-10-01T06:10:00Z", now), "2 hours ago");
    assert.equal(timeAgo("2026-09-28T08:00:00Z", now), "3 days ago");
    assert.equal(timeAgo("2026-10-01T09:00:00Z", now), "just now", "a clock that is slightly ahead is not an error");
  });

  test("countsLabel lists only what there is", () => {
    assert.equal(countsLabel({ urgent: 2, high: 13, medium: 0, low: 3 }), "2 urgent, 13 high, 3 low");
    assert.equal(countsLabel({ urgent: 0, high: 0, medium: 0, low: 0 }), "");
    assert.equal(countsLabel({}), "");
  });

  test("sourceLabel says where the dependency list came from", () => {
    assert.equal(sourceLabel({ method: "lockfiles", manifests: ["package-lock.json"] }), "package-lock.json");
    assert.equal(sourceLabel({ method: "sbom", manifests: ["GitHub dependency graph"] }), "GitHub's dependency graph");
    assert.equal(
      sourceLabel({ method: "both", manifests: ["Cargo.lock", "GitHub dependency graph"] }),
      "Cargo.lock and GitHub's dependency graph"
    );
    assert.equal(
      sourceLabel({ method: "lockfiles", manifests: ["a/go.mod", "b/go.mod", "c/go.mod", "d/go.mod", "e/go.mod"] }),
      "a/go.mod, b/go.mod and 3 more"
    );
  });

  test("the badge snippet is markdown that links back", () => {
    assert.equal(
      badgeMarkdown("https://devlr.example", "0000-token"),
      "[![Dependency health](https://devlr.example/badge/0000-token.svg)](https://devlr.example)"
    );
  });

  test("runtimes are named the way people say them", () => {
    assert.equal(runtimeName("nodejs"), "Node.js");
    assert.equal(runtimeName("alpine-linux"), "Alpine Linux");
    assert.equal(runtimeName("something-new"), "something-new");
  });
});
