import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { cveOf, deprecationKey, fetchDeprecations, fetchEpss, fetchKev, intelFor } from "@/lib/guard/intel";
import { dependencyKey, mergeAdvisories, normalizeAdvisory, queryVulnerabilities } from "@/lib/guard/osv";
import { detectRuntimes, isRuntimePath } from "@/lib/guard/runtimes";
import type { Advisory, Dependency } from "@/lib/guard/types";

const dep = (over: Partial<Dependency> = {}): Dependency => ({
  ecosystem: "npm",
  name: "lodash",
  version: "4.17.20",
  pinned: true,
  direct: true,
  scope: "runtime",
  ...over,
});

/** Replace global fetch for one test. Each call is answered by `respond`. */
function stubFetch(respond: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; body: any }[] = [];
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status = 200, body } = respond(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

afterEach(() => mock.restoreAll());

// A trimmed copy of a real GitHub-reviewed record.
const GHSA_RECORD = {
  id: "GHSA-35jh-r3h4-6jhm",
  aliases: ["CVE-2021-23337"],
  summary: "Command Injection in lodash",
  details: "`lodash` versions prior to 4.17.21 are vulnerable to Command Injection via the template function.",
  modified: "2024-04-17T18:39:19.059Z",
  published: "2021-05-06T16:05:51Z",
  database_specific: { severity: "HIGH", cwe_ids: ["CWE-77", "CWE-94"] },
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H" }],
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
    },
    {
      package: { ecosystem: "npm", name: "lodash-es" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
    },
  ],
  references: [
    { type: "WEB", url: "https://github.com/lodash/lodash/commit/3469357" },
    { type: "ADVISORY", url: "https://nvd.nist.gov/vuln/detail/CVE-2021-23337" },
    { type: "ADVISORY", url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm" },
  ],
};

describe("normalizeAdvisory", () => {
  test("a reviewed GitHub advisory", () => {
    const advisory = normalizeAdvisory(GHSA_RECORD);
    assert.equal(advisory.id, "GHSA-35jh-r3h4-6jhm");
    assert.deepEqual(advisory.aliases, ["CVE-2021-23337"]);
    assert.equal(advisory.summary, "Command Injection in lodash");
    assert.equal(advisory.severity, "high");
    assert.equal(advisory.cvss, 7.2);
    assert.equal(advisory.malicious, false);
    assert.equal(advisory.modified, "2024-04-17T18:39:19.059Z");
    assert.equal(advisory.withdrawn, null);
    assert.equal(advisory.url, "https://github.com/advisories/GHSA-35jh-r3h4-6jhm");
    assert.deepEqual(advisory.fixes, { "npm:lodash": ["4.17.21"], "npm:lodash-es": ["4.17.21"] });
    assert.equal(advisory.imports, undefined);
  });

  test("the database's label wins, and a score from a different band is not shown beside it", () => {
    // Rated high by the reviewers (on a v4 vector), with an older v3 vector that works out to 5.3.
    const advisory = normalizeAdvisory({
      ...GHSA_RECORD,
      severity: [
        { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" },
        { type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N" },
      ],
    });
    assert.equal(advisory.severity, "high");
    assert.equal(advisory.cvss, null);
  });

  test("with no label, severity comes from the vector", () => {
    const advisory = normalizeAdvisory({ ...GHSA_RECORD, id: "PYSEC-2021-1", database_specific: {} });
    assert.equal(advisory.severity, "high");
    assert.equal(advisory.cvss, 7.2);
  });

  test("with neither, severity is unknown rather than guessed", () => {
    const advisory = normalizeAdvisory({ id: "GO-2024-1", affected: [] });
    assert.equal(advisory.severity, "unknown");
    assert.equal(advisory.cvss, null);
  });

  test("malware is recognised by its id or by CWE-506", () => {
    assert.equal(normalizeAdvisory({ id: "MAL-2025-4321" }).malicious, true);
    assert.equal(normalizeAdvisory({ id: "GHSA-xxxx", database_specific: { cwe_ids: ["CWE-506"] } }).malicious, true);
    assert.equal(normalizeAdvisory({ id: "GHSA-xxxx", database_specific: { cwe_ids: ["CWE-79"] } }).malicious, false);
  });

  test("fix versions: every release line is kept, commits are not versions", () => {
    const advisory = normalizeAdvisory({
      id: "GHSA-multi",
      affected: [
        {
          package: { ecosystem: "npm", name: "next" },
          ranges: [
            { type: "SEMVER", events: [{ introduced: "15.0.0" }, { fixed: "15.4.7" }] },
            { type: "SEMVER", events: [{ introduced: "16.0.0" }, { fixed: "16.0.1" }] },
            { type: "GIT", repo: "https://github.com/vercel/next.js", events: [{ introduced: "0" }, { fixed: "9f2c1ab" }] },
          ],
        },
        { package: { ecosystem: "npm", name: "next" }, ranges: [{ type: "SEMVER", events: [{ fixed: "15.4.7" }] }] },
      ],
    });
    assert.deepEqual(advisory.fixes, { "npm:next": ["15.4.7", "16.0.1"] });
  });

  test("an ecosystem with a release suffix is filed under the ecosystem", () => {
    const advisory = normalizeAdvisory({
      id: "PYSEC-1",
      affected: [{ package: { ecosystem: "PyPI:whatever", name: "Typing_Extensions" }, ranges: [{ type: "ECOSYSTEM", events: [{ fixed: "4.1.0" }] }] }],
    });
    assert.deepEqual(advisory.fixes, { "PyPI:typing-extensions": ["4.1.0"] });
  });

  test("a Go record keeps the import paths that are actually affected", () => {
    const advisory = normalizeAdvisory({
      id: "GO-2024-2687",
      summary: "HTTP/2 CONTINUATION flood in net/http",
      affected: [
        {
          package: { ecosystem: "Go", name: "golang.org/x/net" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "0.23.0" }] }],
          ecosystem_specific: { imports: [{ path: "golang.org/x/net/http2", symbols: ["Framer.ReadFrame"] }, { path: "golang.org/x/net" }] },
        },
      ],
    });
    assert.deepEqual(advisory.imports, { "Go:golang.org/x/net": ["golang.org/x/net/http2"] });
    assert.equal(advisory.url, "https://osv.dev/vulnerability/GO-2024-2687");
  });

  test("the link prefers GitHub's advisory page, then a GHSA id, then OSV", () => {
    assert.equal(normalizeAdvisory({ id: "GHSA-abcd-efgh-ijkl" }).url, "https://github.com/advisories/GHSA-abcd-efgh-ijkl");
    assert.equal(normalizeAdvisory({ id: "RUSTSEC-2024-0001" }).url, "https://osv.dev/vulnerability/RUSTSEC-2024-0001");
    assert.equal(
      normalizeAdvisory({ id: "PYSEC-2024-1", references: [{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-zzzz" }] }).url,
      "https://github.com/advisories/GHSA-zzzz"
    );
  });

  test("a missing summary falls back to the first sentence of the details, then the id", () => {
    assert.equal(
      normalizeAdvisory({ id: "PYSEC-1", details: "An issue was discovered in Flask before 2.3.2. More text follows here." }).summary,
      "An issue was discovered in Flask before 2.3.2."
    );
    assert.equal(normalizeAdvisory({ id: "PYSEC-2" }).summary, "PYSEC-2");
  });

  test("a withdrawn record keeps its withdrawal date", () => {
    assert.equal(normalizeAdvisory({ id: "GHSA-w", withdrawn: "2025-03-01T00:00:00Z" }).withdrawn, "2025-03-01T00:00:00Z");
  });
});

describe("mergeAdvisories", () => {
  const advisory = (over: Partial<Advisory>): Advisory => ({
    id: "GHSA-1",
    aliases: [],
    summary: "",
    details: "",
    severity: "unknown",
    cvss: null,
    malicious: false,
    published: null,
    modified: null,
    withdrawn: null,
    url: "",
    fixes: {},
    ...over,
  });

  test("records that share an alias are one issue, and the reviewed one survives", () => {
    const { merged, canonical } = mergeAdvisories([
      advisory({ id: "PYSEC-2023-62", aliases: ["CVE-2023-30861"], fixes: { "PyPI:flask": ["2.2.5"] } }),
      advisory({ id: "GHSA-m2qf-hxjv-5gpq", aliases: ["CVE-2023-30861"], severity: "high", cvss: 7.5, fixes: { "PyPI:flask": ["2.3.2"] } }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "GHSA-m2qf-hxjv-5gpq");
    assert.deepEqual(merged[0].aliases, ["CVE-2023-30861", "PYSEC-2023-62"]);
    assert.deepEqual(merged[0].fixes["PyPI:flask"].sort(), ["2.2.5", "2.3.2"]);
    assert.equal(canonical.get("PYSEC-2023-62"), "GHSA-m2qf-hxjv-5gpq");
    assert.equal(canonical.get("GHSA-m2qf-hxjv-5gpq"), "GHSA-m2qf-hxjv-5gpq");
  });

  test("a record naming the other directly is merged too", () => {
    const { merged } = mergeAdvisories([advisory({ id: "GHSA-1" }), advisory({ id: "RUSTSEC-1", aliases: ["GHSA-1"] })]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "GHSA-1");
  });

  test("a chain of aliases ends up as one group", () => {
    const { merged } = mergeAdvisories([
      advisory({ id: "A-1", aliases: ["CVE-1"] }),
      advisory({ id: "B-1", aliases: ["CVE-1", "CVE-2"] }),
      advisory({ id: "C-1", aliases: ["CVE-2"] }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].aliases, ["B-1", "C-1", "CVE-1", "CVE-2"]);
  });

  test("unrelated advisories stay separate", () => {
    const { merged, canonical } = mergeAdvisories([
      advisory({ id: "GHSA-1", aliases: ["CVE-1"] }),
      advisory({ id: "GHSA-2", aliases: ["CVE-2"] }),
    ]);
    assert.equal(merged.length, 2);
    assert.equal(canonical.get("GHSA-2"), "GHSA-2");
  });

  test("malicious if any record says so, withdrawn only if every record is", () => {
    const { merged } = mergeAdvisories([
      advisory({ id: "GHSA-1", aliases: ["CVE-1"], withdrawn: "2025-01-01T00:00:00Z" }),
      advisory({ id: "MAL-1", aliases: ["CVE-1"], malicious: true }),
    ]);
    assert.equal(merged[0].id, "MAL-1", "the malware record is the one to show");
    assert.equal(merged[0].malicious, true);
    assert.equal(merged[0].withdrawn, null);

    const all = mergeAdvisories([
      advisory({ id: "GHSA-1", aliases: ["CVE-1"], withdrawn: "2025-01-01T00:00:00Z" }),
      advisory({ id: "PYSEC-1", aliases: ["CVE-1"], withdrawn: "2025-01-02T00:00:00Z" }),
    ]);
    assert.equal(all.merged[0].withdrawn, "2025-01-01T00:00:00Z");
  });

  test("a score is borrowed from a duplicate only when it agrees on severity", () => {
    const agree = mergeAdvisories([
      advisory({ id: "GHSA-1", aliases: ["CVE-1"], severity: "high" }),
      advisory({ id: "PYSEC-1", aliases: ["CVE-1"], severity: "high", cvss: 7.5 }),
    ]);
    assert.equal(agree.merged[0].cvss, 7.5);

    const disagree = mergeAdvisories([
      advisory({ id: "GHSA-1", aliases: ["CVE-1"], severity: "high" }),
      advisory({ id: "PYSEC-1", aliases: ["CVE-1"], severity: "moderate", cvss: 5.3 }),
    ]);
    assert.equal(disagree.merged[0].cvss, null);
  });

  test("affected import paths are combined", () => {
    const { merged } = mergeAdvisories([
      advisory({ id: "GHSA-1", aliases: ["CVE-1"], imports: { "Go:m": ["m/a"] } }),
      advisory({ id: "GO-1", aliases: ["CVE-1"], imports: { "Go:m": ["m/a", "m/b"] } }),
    ]);
    assert.deepEqual(merged[0].imports, { "Go:m": ["m/a", "m/b"] });
  });

  test("nothing in, nothing out", () => {
    assert.deepEqual(mergeAdvisories([]), { merged: [], canonical: new Map() });
  });
});

describe("dependencyKey", () => {
  test("PyPI spellings share a key, versions and ecosystems do not", () => {
    assert.equal(dependencyKey(dep({ ecosystem: "PyPI", name: "Typing_Extensions" })), "PyPI:typing-extensions@4.17.20");
    assert.notEqual(dependencyKey(dep()), dependencyKey(dep({ version: "4.17.21" })));
    assert.notEqual(dependencyKey(dep()), dependencyKey(dep({ ecosystem: "PyPI" })));
  });
});

describe("queryVulnerabilities", () => {
  test("sends exact versions only, and maps results back by position", async () => {
    const calls = stubFetch(() => ({
      body: {
        results: [{ vulns: [{ id: "GHSA-1", modified: "2026-01-02T00:00:00Z" }, { id: "GHSA-2", modified: "2026-01-03T00:00:00Z" }] }, {}],
      },
    }));

    const matches = await queryVulnerabilities([
      dep(),
      dep({ name: "left-pad", version: "^1.3.0", pinned: false }),
      dep({ name: "ms", version: "2.1.3" }),
    ]);

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/querybatch$/);
    assert.deepEqual(calls[0].body.queries, [
      { package: { ecosystem: "npm", name: "lodash" }, version: "4.17.20" },
      { package: { ecosystem: "npm", name: "ms" }, version: "2.1.3" },
    ]);
    assert.deepEqual([...matches.byDependency], [["npm:lodash@4.17.20", ["GHSA-1", "GHSA-2"]]]);
    assert.equal(matches.modified.get("GHSA-2"), "2026-01-03T00:00:00Z");
  });

  test("a result that did not fit on one page is asked for again, alone", async () => {
    const calls = stubFetch((_url, init) => {
      const { queries } = JSON.parse(String(init!.body));
      if (queries.length === 2) {
        return { body: { results: [{ vulns: [{ id: "GHSA-1" }], next_page_token: "page-2" }, { vulns: [{ id: "GHSA-9" }] }] } };
      }
      return { body: { results: [{ vulns: [{ id: "GHSA-2" }, { id: "GHSA-1" }] }] } };
    });

    const matches = await queryVulnerabilities([dep(), dep({ name: "ms", version: "2.1.3" })]);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body.queries, [
      { package: { ecosystem: "npm", name: "lodash" }, version: "4.17.20", page_token: "page-2" },
    ]);
    assert.deepEqual(matches.byDependency.get("npm:lodash@4.17.20"), ["GHSA-1", "GHSA-2"], "pages are joined without repeats");
    assert.deepEqual(matches.byDependency.get("npm:ms@2.1.3"), ["GHSA-9"]);
  });

  test("with nothing exact to ask about, OSV is not called", async () => {
    const calls = stubFetch(() => ({ body: {} }));
    const matches = await queryVulnerabilities([dep({ version: "^4", pinned: false })]);
    assert.equal(calls.length, 0);
    assert.equal(matches.byDependency.size, 0);
  });

  test("an OSV failure is an error, never an empty answer", async () => {
    stubFetch(() => ({ status: 503, body: {} }));
    await assert.rejects(queryVulnerabilities([dep()]), /OSV answered 503/);
  });
});

describe("exploit context", () => {
  test("cveOf finds the CVE among an advisory's ids", () => {
    assert.equal(cveOf(["GHSA-1", "cve-2024-1234", "PYSEC-1"]), "CVE-2024-1234");
    assert.equal(cveOf(["GHSA-1", "MAL-2025-1"]), null);
  });

  test("intelFor: exploited if any of its CVEs is listed, and the highest EPSS wins", () => {
    const kev = new Set(["CVE-2024-2"]);
    const epss = new Map([
      ["CVE-2024-1", 0.02],
      ["CVE-2024-2", 0.91],
    ]);
    assert.deepEqual(intelFor(["GHSA-1", "CVE-2024-1", "CVE-2024-2"], kev, epss), { kev: true, epss: 0.91 });
    assert.deepEqual(intelFor(["GHSA-1", "CVE-2024-1"], kev, epss), { kev: false, epss: 0.02 });
    assert.deepEqual(intelFor(["GHSA-1"], kev, epss), { kev: false, epss: null });
  });

  test("fetchKev reads CVE ids from the catalog", async () => {
    stubFetch(() => ({ body: { vulnerabilities: [{ cveID: "CVE-2021-44228" }, { cveID: "cve-2024-3094" }, {}] } }));
    assert.deepEqual([...(await fetchKev())].sort(), ["CVE-2021-44228", "CVE-2024-3094"]);
  });

  test("fetchEpss asks only about real CVE ids, and reads scores as numbers", async () => {
    const calls = stubFetch(() => ({ body: { data: [{ cve: "CVE-2021-44228", epss: "0.94358" }, { cve: "CVE-2024-1", epss: "not a number" }] } }));
    const scores = await fetchEpss(["cve-2021-44228", "GHSA-1", "CVE-2024-1", "CVE-2021-44228"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /cve=CVE-2021-44228,CVE-2024-1$/);
    assert.deepEqual([...scores], [["CVE-2021-44228", 0.94358]]);
  });

  test("fetchEpss makes no request when there is nothing to ask", async () => {
    const calls = stubFetch(() => ({ body: {} }));
    assert.equal((await fetchEpss(["GHSA-1"])).size, 0);
    assert.equal(calls.length, 0);
  });
});

describe("fetchDeprecations", () => {
  const request = dep({ name: "request", version: "2.88.2" });
  const lodash = dep();

  test("asks about direct, exact versions only, and reports what it learned", async () => {
    const calls = stubFetch((url) =>
      url.includes("/request/")
        ? { body: { isDeprecated: true, deprecatedReason: " request has been deprecated " } }
        : { body: { isDeprecated: false } }
    );

    const result = await fetchDeprecations([
      request,
      lodash,
      dep({ name: "nested", direct: false }),
      dep({ name: "ranged", version: "^1", pinned: false }),
      dep({ ecosystem: "Packagist", name: "symfony/console", version: "6.4.0" }),
    ]);

    assert.equal(calls.length, 2);
    assert.deepEqual([...result.deprecated], [["npm:request@2.88.2", { reason: "request has been deprecated" }]]);
    assert.deepEqual([...result.learned].sort(), [
      ["npm:lodash@4.17.20", null],
      ["npm:request@2.88.2", { reason: "request has been deprecated" }],
    ]);
  });

  test("what is already known is not asked again, but is still reported", async () => {
    const calls = stubFetch(() => ({ body: { isDeprecated: false } }));
    const known = new Map([
      [deprecationKey(request), { reason: "request has been deprecated" }],
      [deprecationKey(lodash), null],
    ]);

    const result = await fetchDeprecations([request, lodash, dep({ name: "ms", version: "2.1.3" })], known);

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/ms\/versions\/2\.1\.3$/);
    assert.deepEqual([...result.deprecated.keys()], ["npm:request@2.88.2"]);
    assert.deepEqual([...result.learned], [["npm:ms@2.1.3", null]]);
  });

  test("a package the index has never heard of is simply not deprecated", async () => {
    stubFetch(() => ({ status: 404, body: {} }));
    const result = await fetchDeprecations([lodash]);
    assert.equal(result.deprecated.size, 0);
    assert.deepEqual([...result.learned], [["npm:lodash@4.17.20", null]]);
  });

  test("a failed lookup is not remembered as an answer", async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    const result = await fetchDeprecations([lodash]);
    assert.equal(result.deprecated.size, 0);
    assert.equal(result.learned.size, 0);
  });

  test("PyPI names are looked up in their normalised spelling", async () => {
    const calls = stubFetch(() => ({ body: {} }));
    await fetchDeprecations([dep({ ecosystem: "PyPI", name: "Typing_Extensions", version: "4.0.0" })]);
    assert.match(calls[0].url, /\/systems\/pypi\/packages\/typing-extensions\/versions\/4\.0\.0$/);
  });
});

describe("detectRuntimes", () => {
  const one = (path: string, content: string) => detectRuntimes([{ path, content }]);
  const cycles = (path: string, content: string) => one(path, content).map((r) => `${r.product} ${r.cycle}`);

  test(".nvmrc and .node-version: numbers, v prefixes and LTS codenames", () => {
    assert.deepEqual(one(".nvmrc", "20\n"), [{ product: "nodejs", cycle: "20", version: "20", source: ".nvmrc" }]);
    assert.deepEqual(cycles(".nvmrc", "v22.11.0"), ["nodejs 22"]);
    assert.deepEqual(cycles(".node-version", "# pinned for CI\n18.20.4\n"), ["nodejs 18"]);
    assert.deepEqual(cycles(".nvmrc", "lts/iron"), ["nodejs 20"]);
    assert.deepEqual(cycles(".nvmrc", "lts/Jod"), ["nodejs 22"]);
  });

  test("a floating alias pins nothing, so nothing is claimed", () => {
    for (const value of ["node", "lts/*", "stable", "latest", "lts/unknownname", ""]) {
      assert.deepEqual(one(".nvmrc", value), [], value);
    }
  });

  test("Python, Ruby and runtime.txt", () => {
    assert.deepEqual(cycles(".python-version", "3.11.4\n3.10.9\n"), ["python 3.11"]);
    assert.deepEqual(cycles(".python-version", "3"), [], "a bare major names no cycle");
    assert.deepEqual(cycles(".ruby-version", "ruby-3.2.2"), ["ruby 3.2"]);
    assert.deepEqual(cycles("runtime.txt", "python-3.10.13"), ["python 3.10"]);
    assert.deepEqual(cycles("runtime.txt", "nodejs-20"), []);
  });

  test(".tool-versions: known tools with real versions", () => {
    assert.deepEqual(
      cycles(".tool-versions", "nodejs 20.11.1\npython 3.12.2\nerlang 26.2\ngolang 1.22.1\nruby system\n"),
      ["nodejs 20", "python 3.12", "go 1.22"]
    );
  });

  test("go.mod: the toolchain is what is run; the go line is only a minimum", () => {
    assert.deepEqual(cycles("go.mod", "module x\n\ngo 1.21\n\ntoolchain go1.22.3\n"), ["go 1.22"]);
    assert.deepEqual(cycles("go.mod", "module x\n\ngo 1.21\n"), []);
  });

  test("Dockerfile FROM lines, in the forms they are actually written", () => {
    const dockerfile = [
      "ARG TAG=3.12",
      "FROM --platform=$BUILDPLATFORM node:20-alpine AS build",
      "FROM docker.io/library/python:3.12-slim@sha256:abcdef",
      "FROM ghcr.io/acme/base:1.4",
      "FROM postgres:16",
      "FROM alpine:3.19",
      "FROM ubuntu:22.04",
      "FROM python:${TAG}",
      "FROM redis",
      "FROM scratch",
      "from golang:1.22.1",
    ].join("\n");
    assert.deepEqual(cycles("Dockerfile", dockerfile), [
      "nodejs 20",
      "python 3.12",
      "postgresql 16",
      "alpine-linux 3.19",
      "ubuntu 22.04",
      "go 1.22",
    ]);
    assert.deepEqual(cycles("docker/api.dockerfile", "FROM ruby:3.3"), ["ruby 3.3"]);
  });

  test("a tag too coarse to name a cycle is skipped", () => {
    assert.deepEqual(cycles("Dockerfile", "FROM python:3\nFROM redis:7"), []);
  });

  test("the same runtime pinned in two places is reported once, from the first", () => {
    const found = detectRuntimes([
      { path: ".nvmrc", content: "20" },
      { path: "Dockerfile", content: "FROM node:20-slim\nFROM node:22" },
    ]);
    assert.deepEqual(found.map((r) => `${r.cycle} from ${r.source}`), ["20 from .nvmrc", "22 from Dockerfile"]);
  });

  test("isRuntimePath: pin files at the root, Dockerfiles a little deeper", () => {
    for (const path of [".nvmrc", ".tool-versions", "go.mod", "Dockerfile", "Dockerfile.prod", "docker/Dockerfile", "services/api/Dockerfile", "docker/web.dockerfile"]) {
      assert.equal(isRuntimePath(path), true, path);
    }
    for (const path of ["apps/web/.nvmrc", "a/b/c/Dockerfile", "docs/dockerfile.md", "package.json", "services/api/go.mod"]) {
      assert.equal(isRuntimePath(path), false, path);
    }
  });
});
