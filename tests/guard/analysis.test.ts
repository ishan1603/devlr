import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildFindings, cvesIn, diffFindings, shorten, type FindingsInput } from "@/lib/guard/findings";
import { fixCommand, planFix } from "@/lib/guard/fix";
import { gradeFor, healthOf } from "@/lib/guard/health";
import { dependencyKey } from "@/lib/guard/osv";
import { comparePriority, prioritize } from "@/lib/guard/priority";
import { rollup } from "@/lib/guard/rollup";
import { draftPlan, planUpgrades, type UpgradePlan } from "@/lib/guard/upgrade";
import { compareVersions, isBreakingUpgrade, newest, pickFix } from "@/lib/guard/versions";
import type { Advisory, Dependency, Finding } from "@/lib/guard/types";

const dep = (over: Partial<Dependency> = {}): Dependency => ({
  ecosystem: "npm",
  name: "lodash",
  version: "4.17.20",
  pinned: true,
  direct: true,
  scope: "runtime",
  manifest: "package-lock.json",
  ...over,
});

const advisory = (over: Partial<Advisory> = {}): Advisory => ({
  id: "GHSA-aaaa-bbbb-cccc",
  aliases: ["CVE-2021-23337"],
  summary: "Command injection in lodash",
  details: "",
  severity: "high",
  cvss: 7.2,
  malicious: false,
  published: null,
  modified: null,
  withdrawn: null,
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  fixes: { "npm:lodash": ["4.17.21"] },
  ...over,
});

const NOW = new Date("2026-10-01T12:00:00Z");

const input = (over: Partial<FindingsInput> = {}): FindingsInput => ({
  inventory: { dependencies: [], method: "lockfiles", manifests: [], notes: [] },
  vulnerabilities: new Map(),
  advisories: [],
  canonical: new Map(),
  kev: new Set(),
  epss: new Map(),
  deprecations: new Map(),
  runtimes: [],
  lifecycles: [],
  now: NOW,
  ...over,
});

/** An inventory where every listed dependency matches every listed advisory. */
const vulnerable = (deps: Dependency[], advisories: Advisory[], over: Partial<FindingsInput> = {}) =>
  input({
    inventory: { dependencies: deps, method: "lockfiles", manifests: [], notes: [] },
    vulnerabilities: new Map(deps.map((d) => [dependencyKey(d), advisories.map((a) => a.id)])),
    advisories,
    ...over,
  });

describe("compareVersions", () => {
  const ordered: [string, string][] = [
    ["1.2.3", "1.2.10"],
    ["1.9.9", "1.10.0"],
    ["2.0.0-rc.1", "2.0.0"],
    ["2.0.0-rc.1", "2.0.0-rc.2"],
    ["2.0.0-alpha", "2.0.0-beta"],
    ["1.0.0-1", "1.0.0-alpha"],
    ["1.0.0-rc.1", "1.0.0-rc.1.1"],
    ["1.0.0", "1.0.0.post1"],
    ["1.0.0.post1", "1.0.0.post2"],
    ["1.0.0.post1", "1.0.1"],
    ["31.0-jre", "31.1-jre"],
    ["v0.0.0-20210101000000-abcdef123456", "v0.0.0-20230101000000-abcdef123456"],
    ["0.9", "0.10"],
  ];
  for (const [older, newer] of ordered) {
    test(`${older} is older than ${newer}`, () => {
      assert.ok(compareVersions(older, newer) < 0);
      assert.ok(compareVersions(newer, older) > 0);
    });
  }

  test("spellings of the same version are equal", () => {
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("1.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  });
});

describe("pickFix", () => {
  test("prefers the smallest fix on the installed major", () => {
    assert.equal(pickFix("15.4.5", ["16.0.1", "15.4.7", "15.5.2"]), "15.4.7");
    assert.equal(pickFix("1.2.3", ["2.0.0", "1.2.4", "1.3.0"]), "1.2.4");
  });

  test("reaches for a later major only when the installed one has no fix", () => {
    assert.equal(pickFix("7.0.5", ["10.0.9", "8.0.1"]), "8.0.1");
  });

  test("a fix that is not newer than what is installed is no fix", () => {
    assert.equal(pickFix("15.4.5", ["15.4.1", "14.2.30"]), null);
    assert.equal(pickFix("15.4.5", ["15.4.5"]), null);
    assert.equal(pickFix("15.4.5", []), null);
  });

  test("duplicates and v prefixes do not confuse it", () => {
    assert.equal(pickFix("v1.9.0", ["v1.9.1", "v1.9.1", "1.10.0"]), "v1.9.1");
  });
});

describe("isBreakingUpgrade and newest", () => {
  test("a new major is breaking, a minor or patch is not", () => {
    assert.equal(isBreakingUpgrade("1.2.3", "2.0.0"), true);
    assert.equal(isBreakingUpgrade("1.2.3", "1.9.0"), false);
    assert.equal(isBreakingUpgrade("1.2.3", "1.2.4"), false);
  });

  test("below 1.0 a new minor is breaking too", () => {
    assert.equal(isBreakingUpgrade("0.5.18", "0.6.1"), true);
    assert.equal(isBreakingUpgrade("0.5.18", "0.5.20"), false);
  });

  test("versions that are not numbers make no claim", () => {
    assert.equal(isBreakingUpgrade("main", "1.0.0"), false);
  });

  test("newest picks by version order, not text order", () => {
    assert.equal(newest(["1.9.0", "1.10.0", "1.2.0"]), "1.10.0");
    assert.equal(newest([]), null);
  });
});

describe("prioritize", () => {
  const vuln = (over: Parameters<typeof prioritize>[0] extends infer T ? Partial<T> : never) =>
    prioritize({ kind: "vulnerability", severity: "high", scope: "runtime", hasFix: true, ...over });

  test("a malicious package is always the top", () => {
    assert.deepEqual(prioritize({ kind: "malicious", scope: "dev" }), { priority: "urgent", score: 100 });
  });

  test("a critical bug in shipped code with a fix is urgent", () => {
    assert.equal(vuln({ severity: "critical" }).priority, "urgent");
  });

  test("the same bug in a dev dependency, or with no fix, is not worth a page", () => {
    assert.deepEqual(vuln({ severity: "critical", scope: "dev" }), { priority: "high", score: 65 });
    assert.deepEqual(vuln({ severity: "critical", hasFix: false }), { priority: "high", score: 75 });
  });

  test("active exploitation makes even a moderate bug urgent, unless it never ships", () => {
    assert.deepEqual(vuln({ severity: "moderate", kev: true }), { priority: "urgent", score: 65 });
    assert.deepEqual(vuln({ severity: "moderate", kev: true, scope: "dev" }), { priority: "medium", score: 50 });
  });

  test("severity sets the band", () => {
    assert.deepEqual(vuln({ severity: "high" }), { priority: "high", score: 62 });
    assert.deepEqual(vuln({ severity: "moderate" }), { priority: "medium", score: 40 });
    assert.deepEqual(vuln({ severity: "low" }), { priority: "low", score: 20 });
    assert.deepEqual(vuln({ severity: "unknown" }), { priority: "medium", score: 35 });
  });

  test("dev scope lowers it, a direct dependency and exploit likelihood raise it", () => {
    assert.deepEqual(vuln({ severity: "high", scope: "dev" }), { priority: "medium", score: 47 });
    assert.deepEqual(vuln({ severity: "high", direct: true }), { priority: "high", score: 68 });
    assert.deepEqual(vuln({ severity: "moderate", epss: 0.6 }), { priority: "medium", score: 55 });
    assert.deepEqual(vuln({ severity: "moderate", epss: 0.2 }), { priority: "medium", score: 48 });
    assert.deepEqual(vuln({ severity: "moderate", epss: 0.02 }), { priority: "medium", score: 43 });
    assert.deepEqual(vuln({ severity: "high", scope: "dev", epss: 0.6 }), { priority: "high", score: 62 });
  });

  test("the score never leaves 0 to 100", () => {
    assert.equal(vuln({ severity: "critical", kev: true, epss: 0.9, direct: true }).score, 100);
    assert.equal(vuln({ severity: "low", scope: "dev", hasFix: false }).score, 0);
  });

  test("end of life is pressing once it is close or past", () => {
    assert.deepEqual(prioritize({ kind: "eol", daysLeft: -10 }), { priority: "high", score: 66 });
    assert.deepEqual(prioritize({ kind: "eol", daysLeft: 0 }), { priority: "high", score: 66 });
    assert.deepEqual(prioritize({ kind: "eol", daysLeft: 30 }), { priority: "high", score: 60 });
    assert.deepEqual(prioritize({ kind: "eol", daysLeft: 31 }), { priority: "medium", score: 40 });
  });

  test("deprecations and unchecked manifests are never loud", () => {
    assert.deepEqual(prioritize({ kind: "deprecated", scope: "runtime" }), { priority: "medium", score: 36 });
    assert.deepEqual(prioritize({ kind: "deprecated", scope: "dev" }), { priority: "low", score: 15 });
    assert.deepEqual(prioritize({ kind: "unresolved" }), { priority: "low", score: 22 });
  });

  test("comparePriority orders by priority, then score, then key", () => {
    const items = [
      { priority: "low" as const, score: 22, key: "d" },
      { priority: "high" as const, score: 62, key: "c" },
      { priority: "urgent" as const, score: 80, key: "a" },
      { priority: "high" as const, score: 70, key: "b" },
      { priority: "high" as const, score: 62, key: "a" },
    ];
    assert.deepEqual(items.sort(comparePriority).map((i) => `${i.priority}:${i.score}:${i.key}`), [
      "urgent:80:a",
      "high:70:b",
      "high:62:a",
      "high:62:c",
      "low:22:d",
    ]);
  });
});

describe("planFix", () => {
  const fix = (over: Partial<Dependency>, version: string, breaking = false) =>
    planFix(dep(over), version, { breaking });

  test("npm: install a direct package, refresh a nested one", () => {
    assert.deepEqual(fix({}, "4.17.21"), { command: "npm install lodash@4.17.21", kind: "upgrade" });
    assert.deepEqual(fix({ name: "@babel/core" }, "7.24.0"), { command: "npm install @babel/core@7.24.0", kind: "upgrade" });
    assert.deepEqual(fix({ direct: false }, "4.17.21"), { command: "npm update lodash", kind: "refresh" });
  });

  test("npm: a nested package cannot be refreshed across a breaking release, so the parent is traced", () => {
    assert.deepEqual(fix({ direct: false, name: "adm-zip" }, "0.6.1", true), { command: "npm ls adm-zip", kind: "trace" });
  });

  test("the lockfile decides the package manager", () => {
    assert.equal(fix({ manifest: "apps/web/pnpm-lock.yaml" }, "4.17.21")!.command, "pnpm add lodash@4.17.21");
    assert.deepEqual(fix({ manifest: "pnpm-lock.yaml", direct: false }, "4.17.21"), { command: "pnpm why lodash", kind: "trace" });
    assert.equal(fix({ manifest: "yarn.lock" }, "4.17.21")!.command, "yarn add lodash@4.17.21");
    assert.deepEqual(fix({ manifest: "yarn.lock", direct: false }, "4.17.21"), { command: "yarn why lodash", kind: "trace" });
    assert.equal(fix({ manifest: "bun.lock" }, "4.17.21")!.command, "bun add lodash@4.17.21");
  });

  test("no command is offered where none reliably works", () => {
    assert.equal(fix({ manifest: "bun.lock", direct: false }, "4.17.21"), null);
    assert.equal(fix({ ecosystem: "NuGet", name: "Newtonsoft.Json", direct: false }, "13.0.3"), null);
    assert.equal(fix({ ecosystem: "Maven", name: "org.apache.logging.log4j:log4j-core" }, "2.17.1"), null);
    assert.equal(planFix(dep(), null), null);
    assert.equal(planFix(dep(), undefined), null);
  });

  test("Python: each tool's own command, with shell-special characters quoted", () => {
    const py = { ecosystem: "PyPI" as const, name: "werkzeug" };
    assert.equal(fix({ ...py, manifest: "requirements.txt" }, "3.0.3")!.command, 'pip install "werkzeug>=3.0.3"');
    assert.equal(fix({ ...py, manifest: "poetry.lock" }, "3.0.3")!.command, 'poetry add "werkzeug@^3.0.3"');
    assert.deepEqual(fix({ ...py, manifest: "poetry.lock", direct: false }, "3.0.3"), {
      command: "poetry update werkzeug",
      kind: "refresh",
    });
    assert.equal(fix({ ...py, manifest: "uv.lock" }, "3.0.3")!.command, 'uv add "werkzeug>=3.0.3"');
    assert.equal(fix({ ...py, manifest: "uv.lock", direct: false }, "3.0.3")!.command, "uv lock --upgrade-package werkzeug");
    assert.equal(fix({ ...py, manifest: "Pipfile.lock" }, "3.0.3")!.command, "pipenv update werkzeug");
  });

  test("Go, Rust, Ruby, PHP and .NET", () => {
    const go = { ecosystem: "Go" as const, name: "golang.org/x/net", manifest: "go.mod" };
    assert.deepEqual(fix({ ...go, direct: false }, "v0.23.0"), { command: "go get golang.org/x/net@v0.23.0", kind: "upgrade" });
    assert.equal(fix(go, "0.23.0")!.command, "go get golang.org/x/net@v0.23.0");
    assert.deepEqual(fix({ ecosystem: "crates.io", name: "time", manifest: "Cargo.lock" }, "0.3.36"), {
      command: "cargo update -p time --precise 0.3.36",
      kind: "refresh",
    });
    assert.equal(fix({ ecosystem: "RubyGems", name: "rack", manifest: "Gemfile.lock" }, "3.0.9")!.command, "bundle update rack --conservative");
    const php = { ecosystem: "Packagist" as const, name: "symfony/http-kernel", manifest: "composer.lock" };
    assert.equal(fix(php, "6.4.4")!.command, 'composer require "symfony/http-kernel:^6.4.4"');
    assert.equal(fix({ ...php, direct: false }, "6.4.4")!.command, "composer update symfony/http-kernel --with-dependencies");
    assert.equal(
      fix({ ecosystem: "NuGet", name: "Newtonsoft.Json" }, "13.0.3")!.command,
      "dotnet add package Newtonsoft.Json --version 13.0.3"
    );
  });

  test("fixCommand is the command alone", () => {
    assert.equal(fixCommand(dep(), "4.17.21"), "npm install lodash@4.17.21");
    assert.equal(fixCommand(dep({ ecosystem: "Maven" }), "1.0.0"), null);
  });
});

describe("buildFindings", () => {
  test("one vulnerable dependency gives one finding, with its fix", () => {
    const [finding, ...rest] = buildFindings(vulnerable([dep()], [advisory()]));
    assert.equal(rest.length, 0);
    assert.equal(finding.key, "vulnerability:npm:lodash:GHSA-aaaa-bbbb-cccc");
    assert.equal(finding.kind, "vulnerability");
    assert.equal(finding.title, "lodash 4.17.20: Command injection in lodash");
    assert.equal(finding.summary, "Command injection in lodash.");
    assert.equal(finding.fixedIn, "4.17.21");
    assert.equal(finding.fix, "npm install lodash@4.17.21");
    assert.equal(finding.manifest, "package-lock.json");
    assert.equal(finding.sourceId, "GHSA-aaaa-bbbb-cccc");
    assert.deepEqual(finding.aliases, ["CVE-2021-23337"]);
    assert.deepEqual([finding.priority, finding.score], ["high", 68]);
  });

  test("the key leaves the version out, so moving between vulnerable versions is not a new alert", () => {
    const before = buildFindings(vulnerable([dep({ version: "4.17.15" })], [advisory()]))[0];
    const after = buildFindings(vulnerable([dep({ version: "4.17.20" })], [advisory()]))[0];
    assert.equal(before.key, after.key);
  });

  test("several copies of a package with the same bug are one finding", () => {
    const deps = [
      dep({ version: "4.17.20", direct: false }),
      dep({ version: "3.10.1", direct: false, scope: "dev" }),
      dep({ version: "4.17.15", direct: true, scope: "dev" }),
    ];
    const findings = buildFindings(vulnerable(deps, [advisory()]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].version, "4.17.15", "the copy the repo chose itself is the one reported");
    assert.equal(findings[0].direct, true);
  });

  test("with no direct copy, one that ships is reported, and the oldest of those", () => {
    const deps = [
      dep({ version: "4.17.20", direct: false }),
      dep({ version: "3.10.1", direct: false, scope: "dev" }),
      dep({ version: "4.17.19", direct: false }),
    ];
    assert.equal(buildFindings(vulnerable(deps, [advisory()]))[0].version, "4.17.19");
  });

  test("a withdrawn advisory is not a finding", () => {
    assert.deepEqual(buildFindings(vulnerable([dep()], [advisory({ withdrawn: "2026-01-01T00:00:00Z" })])), []);
  });

  test("an id that was merged away resolves to the advisory that survived", () => {
    const findings = buildFindings(
      input({
        inventory: { dependencies: [dep()], method: "lockfiles", manifests: [], notes: [] },
        vulnerabilities: new Map([[dependencyKey(dep()), ["PYSEC-1", "GHSA-aaaa-bbbb-cccc"]]]),
        advisories: [advisory()],
        canonical: new Map([
          ["PYSEC-1", "GHSA-aaaa-bbbb-cccc"],
          ["GHSA-aaaa-bbbb-cccc", "GHSA-aaaa-bbbb-cccc"],
        ]),
      })
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sourceId, "GHSA-aaaa-bbbb-cccc");
  });

  test("a malicious package is urgent, and its only fix is removal", () => {
    const malware = advisory({ id: "MAL-2026-1234", aliases: [], malicious: true, fixes: {}, summary: "Malicious code in evil-pkg" });
    const [finding] = buildFindings(vulnerable([dep({ name: "evil-pkg", version: "1.0.0", direct: false, scope: "dev" })], [malware]));
    assert.equal(finding.kind, "malicious");
    assert.equal(finding.key, "malicious:npm:evil-pkg:MAL-2026-1234");
    assert.equal(finding.title, "evil-pkg 1.0.0 is a known malicious package");
    assert.deepEqual([finding.priority, finding.score], ["urgent", 100]);
    assert.equal(finding.fix, undefined);
    assert.equal(finding.fixedIn, undefined);
  });

  test("exploit context is attached by CVE and changes the priority", () => {
    const moderate = advisory({ severity: "moderate" });
    const quiet = buildFindings(vulnerable([dep()], [moderate]))[0];
    assert.deepEqual([quiet.priority, quiet.kev, quiet.epss], ["medium", false, null]);

    const loud = buildFindings(
      vulnerable([dep()], [moderate], { kev: new Set(["CVE-2021-23337"]), epss: new Map([["CVE-2021-23337", 0.42]]) })
    )[0];
    assert.deepEqual([loud.priority, loud.kev, loud.epss], ["urgent", true, 0.42]);
  });

  test("with no fix published there is no command, and it is not urgent", () => {
    const [finding] = buildFindings(vulnerable([dep()], [advisory({ severity: "critical", fixes: {} })]));
    assert.equal(finding.fixedIn, undefined);
    assert.equal(finding.fix, undefined);
    assert.equal(finding.priority, "high");
  });

  test("a Go advisory says which import it is about", () => {
    const net = dep({ ecosystem: "Go", name: "golang.org/x/net", version: "v0.20.0", manifest: "go.mod" });
    const two = advisory({
      id: "GO-2024-2687",
      summary: "HTTP/2 CONTINUATION flood",
      fixes: { "Go:golang.org/x/net": ["0.23.0"] },
      imports: { "Go:golang.org/x/net": ["golang.org/x/net/http2"] },
    });
    assert.equal(
      buildFindings(vulnerable([net], [two]))[0].summary,
      "HTTP/2 CONTINUATION flood. Only code that imports golang.org/x/net/http2 is affected."
    );
    assert.deepEqual(buildFindings(vulnerable([net], [two]))[0].imports, ["golang.org/x/net/http2"]);

    const three = { ...two, imports: { "Go:golang.org/x/net": ["a/x", "a/y", "a/z"] } };
    assert.match(buildFindings(vulnerable([net], [three]))[0].summary, /imports a\/x or a\/y \(or related packages\) is affected\.$/);
  });

  test("a deprecated version carries the maintainer's own notice", () => {
    const request = dep({ name: "request", version: "2.88.2" });
    const findings = buildFindings(
      input({
        inventory: { dependencies: [request, dep()], method: "lockfiles", manifests: [], notes: [] },
        deprecations: new Map([["npm:request@2.88.2", { reason: "request has been deprecated, see https://github.com/request/request/issues/3142" }]]),
      })
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, "deprecated:npm:request");
    assert.equal(findings[0].title, "request 2.88.2 is deprecated");
    assert.equal(findings[0].summary, "request has been deprecated, see https://github.com/request/request/issues/3142.");
    assert.deepEqual([findings[0].priority, findings[0].score], ["medium", 36]);
  });

  test("a deprecation with no message still says something true", () => {
    const [finding] = buildFindings(
      input({
        inventory: { dependencies: [dep({ scope: "dev" })], method: "lockfiles", manifests: [], notes: [] },
        deprecations: new Map([["npm:lodash@4.17.20", { reason: "" }]]),
      })
    );
    assert.equal(finding.summary, "Its maintainers have marked this version deprecated.");
    assert.equal(finding.priority, "low");
  });

  describe("end of life", () => {
    const runtime = { product: "nodejs", cycle: "20", version: "20.11.1", source: ".nvmrc" };
    const lifecycle = (eolDate: string) => ({ product: "nodejs", cycle: "20", eolDate, name: "Node.js", latest: "26", link: "https://endoflife.date/nodejs" });
    const eol = (eolDate: string) => buildFindings(input({ runtimes: [runtime], lifecycles: [lifecycle(eolDate)] }));

    test("already past", () => {
      const [finding] = eol("2026-04-30");
      assert.equal(finding.key, "eol:nodejs:20");
      assert.equal(finding.title, "Node.js 20 reached end of life on 2026-04-30");
      assert.equal(finding.summary, ".nvmrc pins Node.js 20.11.1. It no longer receives security fixes. The current release is 26.");
      assert.deepEqual([finding.priority, finding.score], ["high", 66]);
      assert.equal(finding.url, "https://endoflife.date/nodejs");
    });

    test("today, tomorrow, within a month, within the horizon", () => {
      assert.equal(eol("2026-10-01")[0].title, "Node.js 20 reaches end of life today");
      assert.equal(eol("2026-10-02")[0].title, "Node.js 20 reaches end of life on 2026-10-02, in 1 day");
      assert.equal(eol("2026-10-31")[0].title, "Node.js 20 reaches end of life on 2026-10-31, in 30 days");
      assert.equal(eol("2026-10-31")[0].priority, "high");
      assert.equal(eol("2026-12-15")[0].priority, "medium");
      assert.match(eol("2026-12-15")[0].summary, /After that date it stops receiving security fixes\./);
    });

    test("further out than the horizon is not worth mentioning yet", () => {
      assert.deepEqual(eol("2026-12-31"), []);
      assert.equal(eol("2026-12-30").length, 1);
    });

    test("a runtime with no known lifecycle is left alone", () => {
      assert.deepEqual(buildFindings(input({ runtimes: [{ ...runtime, cycle: "21" }], lifecycles: [lifecycle("2026-04-30")] })), []);
    });

    test("the current release is not suggested to someone already on it", () => {
      const current = { ...lifecycle("2026-04-30"), latest: "20" };
      assert.doesNotMatch(buildFindings(input({ runtimes: [runtime], lifecycles: [current] }))[0].summary, /current release/);
    });
  });

  describe("what could not be checked", () => {
    const range = (name: string, manifest = "package.json") =>
      dep({ name, version: "^1.0.0", pinned: false, manifest });

    test("one finding per manifest, not one per package", () => {
      const findings = buildFindings(
        input({
          inventory: {
            dependencies: [range("left-pad"), range("ms"), range("chalk"), range("debug"), range("flask", "api/requirements.txt")],
            method: "lockfiles",
            manifests: [],
            notes: [],
          },
        })
      );
      assert.deepEqual(findings.map((f) => f.key).sort(), ["unresolved:api/requirements.txt", "unresolved:package.json"]);
      const npm = findings.find((f) => f.key === "unresolved:package.json")!;
      assert.equal(npm.title, "4 dependencies in package.json could not be checked");
      assert.match(npm.summary, /^They are declared as version ranges with no lockfile \(left-pad, ms, chalk, and others\)/);
      assert.match(npm.summary, /Commit a lockfile to have them checked\.$/);
      assert.equal(npm.priority, "low");
    });

    test("a single one is described in the singular", () => {
      const [finding] = buildFindings(
        input({ inventory: { dependencies: [range("left-pad")], method: "lockfiles", manifests: [], notes: [] } })
      );
      assert.equal(finding.title, "1 dependency in package.json could not be checked");
      assert.match(finding.summary, /^It is declared as a version range with no lockfile \(left-pad\)/);
      assert.match(finding.summary, /to have it checked\.$/);
    });

    test("a workflow's floating action tag is not a missing lockfile", () => {
      const action = dep({ ecosystem: "GitHub Actions", name: "actions/checkout", version: "6.*.*", pinned: false, manifest: "dependency graph" });
      assert.deepEqual(
        buildFindings(input({ inventory: { dependencies: [action], method: "sbom", manifests: [], notes: [] } })),
        []
      );
    });
  });

  test("findings come back most pressing first", () => {
    const critical = advisory({ id: "GHSA-crit", aliases: [], severity: "critical" });
    const low = advisory({ id: "GHSA-low", aliases: [], severity: "low" });
    const findings = buildFindings(
      vulnerable([dep()], [low, critical], {
        deprecations: new Map([["npm:lodash@4.17.20", { reason: "Use something else" }]]),
      })
    );
    assert.deepEqual(findings.map((f) => f.priority), ["urgent", "medium", "low"]);
  });
});

describe("shorten", () => {
  test("short text is left alone", () => {
    assert.equal(shorten("Command injection in lodash", 110), "Command injection in lodash");
  });

  test("long text is cut at a word, and says it was cut", () => {
    const long = "OpenTelemetry JavaScript: Denial of service in the Jaeger propagator via an unhandled exception on a malformed header value sent by a remote peer";
    const cut = shorten(long, 80);
    assert.ok(cut.length <= 83, `${cut.length}`);
    assert.ok(cut.endsWith("..."));
    assert.ok(long.startsWith(cut.slice(0, -3)));
    assert.doesNotMatch(cut, /\s\.\.\.$/);
  });

  test("a single enormous word is still cut", () => {
    assert.equal(shorten("a".repeat(200), 50).length, 53);
  });
});

describe("diffFindings", () => {
  const f = (key: string, priority: Finding["priority"]) => ({ key, priority }) as Finding;

  test("new, still there, gone", () => {
    const diff = diffFindings(
      [
        { key: "a", priority: "high" },
        { key: "gone", priority: "low" },
      ],
      [f("a", "high"), f("new", "medium")]
    );
    assert.deepEqual(diff.added.map((x) => x.key), ["new"]);
    assert.deepEqual(diff.unchanged.map((x) => x.key), ["a"]);
    assert.deepEqual(diff.resolvedKeys, ["gone"]);
    assert.deepEqual(diff.escalated, []);
  });

  test("something already reported is only news again if it has become urgent", () => {
    const diff = diffFindings(
      [
        { key: "now-urgent", priority: "medium" },
        { key: "now-high", priority: "medium" },
        { key: "still-urgent", priority: "urgent" },
        { key: "calmer", priority: "urgent" },
      ],
      [f("now-urgent", "urgent"), f("now-high", "high"), f("still-urgent", "urgent"), f("calmer", "high")]
    );
    assert.deepEqual(diff.escalated.map((x) => x.key), ["now-urgent"]);
    assert.deepEqual(diff.unchanged.map((x) => x.key), ["now-high", "still-urgent", "calmer"]);
    assert.deepEqual(diff.added, []);
  });

  test("a first scan reports everything, and an empty one resolves everything", () => {
    assert.equal(diffFindings([], [f("a", "low"), f("b", "low")]).added.length, 2);
    assert.deepEqual(diffFindings([{ key: "a", priority: "low" }], []).resolvedKeys, ["a"]);
  });
});

describe("cvesIn", () => {
  test("one CVE per advisory, without repeats", () => {
    assert.deepEqual(
      cvesIn([
        advisory({ id: "GHSA-1", aliases: ["CVE-2024-1", "PYSEC-1"] }),
        advisory({ id: "CVE-2024-2", aliases: [] }),
        advisory({ id: "GHSA-3", aliases: ["cve-2024-1"] }),
        advisory({ id: "MAL-1", aliases: [] }),
      ]).sort(),
      ["CVE-2024-1", "CVE-2024-2"]
    );
  });
});

describe("healthOf", () => {
  const entries = (count: number, priority: Finding["priority"], kind: Finding["kind"] = "vulnerability") =>
    Array.from({ length: count }, () => ({ priority, kind }));

  test("nothing to fix is a perfect score", () => {
    assert.deepEqual(healthOf([]), { score: 100, grade: "A", counts: { urgent: 0, high: 0, medium: 0, low: 0 } });
  });

  test("anything urgent caps the score, however tidy the rest", () => {
    assert.deepEqual([healthOf(entries(1, "urgent")).score, healthOf(entries(1, "urgent")).grade], [55, "D"]);
  });

  test("malware caps it harder", () => {
    const health = healthOf(entries(1, "urgent", "malicious"));
    assert.deepEqual([health.score, health.grade], [20, "F"]);
  });

  test("a pile of low-priority entries cannot outweigh one serious one", () => {
    assert.equal(healthOf(entries(30, "low")).score, 90);
    assert.equal(healthOf(entries(10, "medium")).score, 70);
    assert.equal(healthOf(entries(10, "high")).score, 40);
    assert.ok(healthOf(entries(30, "low")).score > healthOf(entries(1, "high")).score);
  });

  test("a mixed repo adds up, and reports what it counted", () => {
    const health = healthOf([...entries(1, "high"), ...entries(2, "medium"), ...entries(1, "low")]);
    assert.deepEqual(health, { score: 72, grade: "C", counts: { urgent: 0, high: 1, medium: 2, low: 1 } });
  });

  test("the score never goes below zero", () => {
    assert.equal(healthOf([...entries(5, "urgent"), ...entries(10, "high"), ...entries(10, "medium")]).score, 0);
  });

  test("grade boundaries", () => {
    assert.deepEqual([100, 90, 89, 75, 74, 60, 59, 40, 39, 0].map(gradeFor), ["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
  });
});

// ---------------------------------------------------------------------------
// One upgrade per package
// ---------------------------------------------------------------------------

const finding = (over: Partial<Finding> = {}): Finding => {
  const sourceId = over.sourceId ?? "GHSA-1";
  const name = over.package ?? "next";
  return {
    key: `${over.kind ?? "vulnerability"}:npm:${name}:${sourceId}`,
    kind: "vulnerability",
    priority: "high",
    score: 68,
    ecosystem: "npm",
    package: name,
    version: "15.4.5",
    direct: true,
    scope: "runtime",
    manifest: "package-lock.json",
    sourceId,
    aliases: [],
    severity: "high",
    cvss: null,
    kev: false,
    epss: null,
    title: `${name} ${over.version ?? "15.4.5"}: Something breaks`,
    summary: "Something breaks.",
    fixedIn: "15.4.7",
    fix: `npm install ${name}@15.4.7`,
    url: `https://github.com/advisories/${sourceId}`,
    ...over,
  };
};

/** A stand-in for OSV: which advisory ids apply at which exact version. */
function fakeOsv(vulnerableAt: Record<string, string[]>, advisories: Advisory[] = []) {
  const queries: string[][] = [];
  return {
    queries,
    query: async (deps: Dependency[]) => {
      queries.push(deps.map((d) => `${d.name}@${d.version}`));
      const out = new Map<string, string[]>();
      for (const d of deps) {
        const ids = vulnerableAt[`${d.name}@${d.version}`];
        if (ids?.length) out.set(dependencyKey(d), ids);
      }
      return out;
    },
    advisory: async (id: string) => advisories.find((a) => a.id === id || a.aliases.includes(id)) ?? null,
  };
}

const later = (id: string, fixes: string[], over: Partial<Advisory> = {}) =>
  advisory({ id, aliases: [], fixes: fixes.length ? { "npm:next": fixes } : {}, ...over });

describe("draftPlan", () => {
  test("the target is the highest fix among the findings", () => {
    const plan = draftPlan([finding({ fixedIn: "15.4.7" }), finding({ sourceId: "GHSA-2", fixedIn: "15.5.24" })]);
    assert.deepEqual(plan, {
      ecosystem: "npm",
      name: "next",
      from: "15.4.5",
      target: "15.5.24",
      verified: false,
      breaking: false,
      remaining: [],
    });
  });

  test("an advisory with no fix of its own is not cleared by another's", () => {
    const plan = draftPlan([finding(), finding({ sourceId: "GHSA-9", fixedIn: undefined })]);
    assert.equal(plan.target, "15.4.7");
    assert.deepEqual(plan.remaining, ["GHSA-9"]);
  });

  test("with no fix anywhere there is no target", () => {
    const plan = draftPlan([finding({ fixedIn: undefined })]);
    assert.equal(plan.target, null);
    assert.equal(plan.breaking, false);
    assert.deepEqual(plan.remaining, ["GHSA-1"]);
  });
});

describe("planUpgrades", () => {
  const two = [finding({ fixedIn: "15.4.7" }), finding({ sourceId: "GHSA-2", fixedIn: "15.5.24" })];

  test("a target OSV has nothing against is verified", async () => {
    const osv = fakeOsv({});
    const plan = (await planUpgrades(two, osv)).get("npm:next")!;
    assert.deepEqual([plan.target, plan.verified, plan.remaining], ["15.5.24", true, []]);
    assert.deepEqual(osv.queries, [["next@15.5.24"]]);
  });

  test("a target that is still affected moves up to that advisory's fix, and is checked again", async () => {
    const osv = fakeOsv({ "next@15.5.24": ["GHSA-3"] }, [later("GHSA-3", ["15.5.30", "16.0.2"])]);
    const plan = (await planUpgrades(two, osv)).get("npm:next")!;
    assert.deepEqual([plan.target, plan.verified, plan.breaking, plan.remaining], ["15.5.30", true, false, []]);
    assert.deepEqual(osv.queries, [["next@15.5.24"], ["next@15.5.30"]]);
  });

  test("when the only way out is a new major, the plan says so", async () => {
    const osv = fakeOsv({ "next@15.5.24": ["GHSA-3"] }, [later("GHSA-3", ["16.0.2"])]);
    const plan = (await planUpgrades(two, osv)).get("npm:next")!;
    assert.deepEqual([plan.target, plan.verified, plan.breaking], ["16.0.2", true, true]);
  });

  test("an advisory nothing fixes stays on the plan, unverified", async () => {
    const findings = [finding(), finding({ sourceId: "GHSA-9", fixedIn: undefined })];
    const osv = fakeOsv({ "next@15.4.7": ["GHSA-9"] }, [later("GHSA-9", [])]);
    const plan = (await planUpgrades(findings, osv)).get("npm:next")!;
    assert.deepEqual([plan.target, plan.verified, plan.remaining], ["15.4.7", false, ["GHSA-9"]]);
  });

  test("an unfixed advisory that no longer applies at the target is cleared after all", async () => {
    const findings = [finding(), finding({ sourceId: "GHSA-9", fixedIn: undefined })];
    const plan = (await planUpgrades(findings, fakeOsv({}))).get("npm:next")!;
    assert.deepEqual([plan.verified, plan.remaining], [true, []]);
  });

  test("an advisory that cannot be loaded counts as still applying", async () => {
    const plan = (await planUpgrades(two, fakeOsv({ "next@15.5.24": ["GHSA-mystery"] }))).get("npm:next")!;
    assert.deepEqual([plan.target, plan.verified, plan.remaining], ["15.5.24", false, ["GHSA-mystery"]]);
  });

  test("a withdrawn advisory at the target does not block it", async () => {
    const osv = fakeOsv({ "next@15.5.24": ["GHSA-3"] }, [later("GHSA-3", ["15.5.30"], { withdrawn: "2026-01-01T00:00:00Z" })]);
    assert.equal((await planUpgrades(two, osv)).get("npm:next")!.verified, true);
  });

  test("one issue coming back under two ids is counted once", async () => {
    const osv = fakeOsv({ "next@15.5.24": ["GHSA-3", "CVE-2026-1"] }, [later("GHSA-3", [], { aliases: ["CVE-2026-1"] })]);
    assert.deepEqual((await planUpgrades(two, osv)).get("npm:next")!.remaining, ["GHSA-3"]);
  });

  test("it gives up after a few rounds, on the last version it actually checked", async () => {
    const osv = fakeOsv(
      { "next@15.5.24": ["GHSA-3"], "next@15.5.30": ["GHSA-4"], "next@15.5.40": ["GHSA-5"] },
      [later("GHSA-3", ["15.5.30"]), later("GHSA-4", ["15.5.40"]), later("GHSA-5", ["15.5.50"])]
    );
    const plan = (await planUpgrades(two, osv)).get("npm:next")!;
    assert.deepEqual([plan.target, plan.verified, plan.remaining], ["15.5.40", false, ["GHSA-5"]]);
    assert.equal(osv.queries.length, 3);
  });

  test("every package is checked in the same request", async () => {
    const findings = [...two, finding({ package: "ws", version: "8.17.0", fixedIn: "8.17.1" })];
    const osv = fakeOsv({});
    const plans = await planUpgrades(findings, osv);
    assert.deepEqual(osv.queries, [["next@15.5.24", "ws@8.17.1"]]);
    assert.deepEqual([...plans.keys()].sort(), ["npm:next", "npm:ws"]);
    assert.equal(plans.get("npm:ws")!.from, "8.17.0");
  });

  test("with nothing to upgrade to, OSV is not asked", async () => {
    const osv = fakeOsv({});
    const plans = await planUpgrades([finding({ fixedIn: undefined })], osv);
    assert.equal(plans.get("npm:next")!.target, null);
    assert.deepEqual(osv.queries, []);
  });

  test("findings that are not vulnerabilities have no upgrade plan", async () => {
    const osv = fakeOsv({});
    const plans = await planUpgrades(
      [finding({ kind: "deprecated" }), finding({ kind: "malicious" }), finding({ kind: "eol", package: undefined, ecosystem: undefined })],
      osv
    );
    assert.equal(plans.size, 0);
    assert.deepEqual(osv.queries, []);
  });
});

describe("rollup", () => {
  const plan = (over: Partial<UpgradePlan> = {}): UpgradePlan => ({
    ecosystem: "npm",
    name: "next",
    from: "15.4.5",
    target: "15.5.24",
    verified: true,
    breaking: false,
    remaining: [],
    ...over,
  });
  const plans = (over: Partial<UpgradePlan> = {}, key = "npm:next") => new Map([[key, plan(over)]]);

  test("many advisories against one package become one entry with one upgrade", () => {
    const findings = [
      finding({ sourceId: "GHSA-2" }),
      finding({ sourceId: "GHSA-1", severity: "critical", priority: "urgent", score: 86, kev: true }),
      finding({ sourceId: "GHSA-3", fixedIn: "15.5.24" }),
    ];
    const [entry, ...rest] = rollup(findings, plans());
    assert.equal(rest.length, 0);
    assert.equal(entry.key, "npm:next");
    assert.equal(entry.title, "next 15.4.5 has 3 known vulnerabilities (1 critical, 2 high)");
    assert.equal(entry.action, "Upgrade to 15.5.24. That clears all 3.");
    assert.equal(entry.command, "npm install next@15.5.24");
    assert.deepEqual([entry.priority, entry.score, entry.kind, entry.kev], ["urgent", 86, "vulnerability", true]);
    assert.deepEqual(entry.severities, { critical: 1, high: 2 });
    assert.deepEqual(entry.versions, ["15.4.5"]);
    assert.equal(entry.url, undefined, "three advisories have three pages");
    assert.equal(entry.findings[0].sourceId, "GHSA-1", "most pressing first");
    assert.equal(entry.findings.length, 3);
  });

  test("a single advisory keeps its own title and links to its page", () => {
    const [entry] = rollup([finding()], plans({ target: "15.4.7" }));
    assert.equal(entry.title, "next 15.4.5: Something breaks");
    assert.equal(entry.action, "Upgrade to 15.4.7.");
    assert.equal(entry.url, "https://github.com/advisories/GHSA-1");
  });

  test("an upgrade that fixes only some of them says how many", () => {
    const findings = [finding(), finding({ sourceId: "GHSA-9", fixedIn: undefined, fix: undefined })];
    const [entry] = rollup(findings, plans({ target: "15.4.7", verified: false, remaining: ["GHSA-9"] }));
    assert.equal(entry.action, "Upgrade to 15.4.7, which fixes 1 of 2. The other still applies at that version.");
    assert.equal(entry.command, "npm install next@15.4.7");
  });

  test("a target with advisories of its own is not recommended blindly", () => {
    const findings = [finding(), finding({ sourceId: "GHSA-2", fixedIn: "15.5.24" })];
    const [entry] = rollup(findings, plans({ target: "15.5.40", verified: false, remaining: ["GHSA-5"] }));
    assert.equal(
      entry.action,
      "15.5.40 fixes these, but it has other known advisories of its own. Read them before upgrading."
    );
  });

  test("with no fix published, it says so and offers no command", () => {
    const one = rollup([finding({ fixedIn: undefined, fix: undefined })], plans({ target: null, verified: false, remaining: ["GHSA-1"] }))[0];
    assert.equal(one.action, "No fixed version has been published yet.");
    assert.equal(one.command, undefined);

    const several = rollup(
      [finding({ fixedIn: undefined }), finding({ sourceId: "GHSA-2", fixedIn: undefined })],
      plans({ target: null, verified: false, remaining: ["GHSA-1", "GHSA-2"] })
    )[0];
    assert.equal(several.action, "No fixed version has been published for any of them yet.");
  });

  test("without a verified plan the target is offered, but nothing is promised", () => {
    const [entry] = rollup([finding(), finding({ sourceId: "GHSA-2", fixedIn: "15.5.24" })]);
    assert.equal(entry.action, "Upgrade to 15.5.24.");
    assert.equal(entry.upgrade!.verified, false);
    assert.equal(entry.command, "npm install next@15.5.24");
  });

  test("a breaking release of a package the repo chose comes with a warning", () => {
    const findings = [finding({ package: "nodemailer", version: "7.0.5" }), finding({ package: "nodemailer", version: "7.0.5", sourceId: "GHSA-2" })];
    const [entry] = rollup(findings, plans({ name: "nodemailer", from: "7.0.5", target: "10.0.9", breaking: true }, "npm:nodemailer"));
    assert.equal(entry.action, "Upgrade to 10.0.9. That clears all 2. That is a breaking release, so read its changelog first.");
  });

  describe("a package pulled in by another", () => {
    const nested = (over: Partial<Finding>) => finding({ direct: false, ...over });

    test("npm, within range: the command re-resolves it", () => {
      const [entry] = rollup(
        [nested({ package: "protobufjs", version: "7.5.3" })],
        plans({ name: "protobufjs", from: "7.5.3", target: "7.5.5" }, "npm:protobufjs")
      );
      assert.equal(entry.command, "npm update protobufjs");
      assert.equal(
        entry.action,
        "Upgrade to 7.5.5. It is pulled in by another package. The command re-resolves it within the range its parent allows."
      );
    });

    test("npm, across a breaking release: the command finds the parent", () => {
      const [entry] = rollup(
        [nested({ package: "adm-zip", version: "0.5.18" })],
        plans({ name: "adm-zip", from: "0.5.18", target: "0.6.1", breaking: true }, "npm:adm-zip")
      );
      assert.equal(entry.command, "npm ls adm-zip");
      assert.equal(
        entry.action,
        "Upgrade to 0.6.1. It is pulled in by another package. The command shows which one, and that is the one to upgrade."
      );
    });

    test("cargo, across a breaking release: the refresh may not reach it", () => {
      const [entry] = rollup(
        [nested({ ecosystem: "crates.io", package: "time", version: "0.2.27", manifest: "Cargo.lock" })],
        plans({ ecosystem: "crates.io", name: "time", from: "0.2.27", target: "0.3.36", breaking: true }, "crates.io:time")
      );
      assert.equal(entry.command, "cargo update -p time --precise 0.3.36");
      assert.match(entry.action, /a breaking release its parent may not allow\. If the command does not move it, upgrade the parent\.$/);
    });

    test("go: asking for the version works for an indirect module too", () => {
      const [entry] = rollup(
        [nested({ ecosystem: "Go", package: "golang.org/x/net", version: "v0.20.0", manifest: "go.mod" })],
        plans({ ecosystem: "Go", name: "golang.org/x/net", from: "v0.20.0", target: "0.23.0", breaking: true }, "Go:golang.org/x/net")
      );
      assert.equal(entry.command, "go get golang.org/x/net@v0.23.0");
      assert.equal(entry.action, "Upgrade to 0.23.0.");
    });

    test("bun: no reliable command, so it says what to do instead", () => {
      const [entry] = rollup(
        [nested({ package: "ws", version: "8.17.0", manifest: "bun.lock" })],
        plans({ name: "ws", from: "8.17.0", target: "8.17.1" }, "npm:ws")
      );
      assert.equal(entry.command, undefined);
      assert.equal(entry.action, "Upgrade to 8.17.1. It is pulled in by another package, so the parent is what needs upgrading.");
    });
  });

  test("a single advisory limited to certain imports says so beside the advice", () => {
    const crypto = finding({
      ecosystem: "Go",
      package: "golang.org/x/crypto",
      version: "v0.56.0",
      direct: false,
      manifest: "go.mod",
      fixedIn: undefined,
      fix: undefined,
      imports: ["golang.org/x/crypto/openpgp"],
    });
    assert.equal(
      rollup([crypto])[0].action,
      "No fixed version has been published yet. Only code that imports golang.org/x/crypto/openpgp is affected."
    );

    // With several advisories the scope differs for each, so it stays with the advisory.
    const two = rollup([crypto, { ...crypto, key: "other", sourceId: "GO-2", imports: ["golang.org/x/crypto/ssh"] }])[0];
    assert.doesNotMatch(two.action, /Only code that imports/);
  });

  test("malware is removed, not upgraded", () => {
    const [entry] = rollup([
      finding({
        kind: "malicious",
        package: "evil-pkg",
        version: "1.0.0",
        priority: "urgent",
        score: 100,
        title: "evil-pkg 1.0.0 is a known malicious package",
        fixedIn: undefined,
        fix: undefined,
      }),
    ]);
    assert.equal(entry.kind, "malicious");
    assert.equal(entry.title, "evil-pkg 1.0.0 is a known malicious package");
    assert.match(entry.action, /^Remove it now, then rotate any credentials/);
    assert.equal(entry.command, undefined);
  });

  test("a deprecation on its own carries the maintainer's notice", () => {
    const [entry] = rollup([
      finding({
        kind: "deprecated",
        package: "request",
        version: "2.88.2",
        priority: "medium",
        score: 36,
        title: "request 2.88.2 is deprecated",
        summary: "request has been deprecated.",
        fixedIn: undefined,
        fix: undefined,
        url: undefined,
        sourceId: undefined,
      }),
    ]);
    assert.equal(entry.title, "request 2.88.2 is deprecated");
    assert.equal(entry.action, "request has been deprecated.");
    assert.equal(entry.upgrade, undefined);
    assert.equal(entry.command, undefined);
  });

  test("vulnerable and deprecated is one entry that mentions both", () => {
    const findings = [
      finding({ package: "inngest", version: "3.40.1", fixedIn: "3.54.0" }),
      finding({ kind: "deprecated", package: "inngest", version: "3.40.1", priority: "medium", score: 36, fixedIn: undefined, url: undefined }),
    ];
    const [entry, ...rest] = rollup(findings, plans({ name: "inngest", from: "3.40.1", target: "3.54.0" }, "npm:inngest"));
    assert.equal(rest.length, 0);
    assert.equal(entry.action, "Upgrade to 3.54.0. This version is also deprecated.");
    assert.equal(entry.url, "https://github.com/advisories/GHSA-1", "the one advisory's page");
  });

  test("a finding that is not about a package passes through as its own entry", () => {
    const eol: Finding = {
      key: "eol:nodejs:20",
      kind: "eol",
      priority: "high",
      score: 66,
      sourceId: "nodejs",
      version: "20",
      title: "Node.js 20 reached end of life on 2026-04-30",
      summary: ".nvmrc pins Node.js 20.11.1. It no longer receives security fixes.",
      url: "https://endoflife.date/nodejs",
    };
    const [entry] = rollup([eol]);
    assert.equal(entry.key, "eol:nodejs:20");
    assert.equal(entry.action, eol.summary);
    assert.equal(entry.url, eol.url);
    assert.deepEqual(entry.versions, ["20"]);
    assert.equal(entry.package, undefined);
  });

  test("entries are ordered most pressing first, and copies of a package are listed oldest first", () => {
    const entries = rollup([
      finding({ package: "ws", version: "8.17.0", priority: "medium", score: 40 }),
      finding({ package: "lodash", version: "4.17.20", priority: "high", score: 68 }),
      finding({ package: "lodash", version: "3.10.1", sourceId: "GHSA-2", priority: "medium", score: 40 }),
      finding({ package: "next", priority: "urgent", score: 86 }),
    ]);
    assert.deepEqual(entries.map((e) => e.package), ["next", "lodash", "ws"]);
    assert.deepEqual(entries[1].versions, ["3.10.1", "4.17.20"]);
    assert.equal(entries[1].title, "lodash 4.17.20 has 2 known vulnerabilities (2 high)");
  });

  test("PyPI spellings of one name are one package", () => {
    const entries = rollup([
      finding({ ecosystem: "PyPI", package: "typing_extensions", version: "4.0.0" }),
      finding({ ecosystem: "PyPI", package: "typing-extensions", version: "4.0.0", sourceId: "GHSA-2" }),
    ]);
    assert.equal(entries.length, 1);
  });
});
