import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isPinned, normalizePypiName, packageKey, parsePurl } from "@/lib/guard/purl";
import { cvss3BaseScore, severityFromLabel, severityFromScore } from "@/lib/guard/cvss";

describe("parsePurl", () => {
  test("npm, including scoped names in both encodings", () => {
    assert.deepEqual(parsePurl("pkg:npm/lodash@4.17.20"), { ecosystem: "npm", name: "lodash", version: "4.17.20" });
    assert.deepEqual(parsePurl("pkg:npm/%40babel/core@7.24.0"), {
      ecosystem: "npm",
      name: "@babel/core",
      version: "7.24.0",
    });
    assert.deepEqual(parsePurl("pkg:npm/@babel/core@7.24.0"), {
      ecosystem: "npm",
      name: "@babel/core",
      version: "7.24.0",
    });
  });

  test("a scoped name with no version is not mistaken for name@version", () => {
    assert.deepEqual(parsePurl("pkg:npm/@babel/core"), { ecosystem: "npm", name: "@babel/core", version: "" });
  });

  test("an encoded range is decoded, and is then visibly not a version", () => {
    const parsed = parsePurl("pkg:npm/xo@%5E0.58.0")!;
    assert.equal(parsed.version, "^0.58.0");
    assert.equal(isPinned(parsed.version), false);
  });

  test("Go modules keep their full import path", () => {
    assert.deepEqual(parsePurl("pkg:golang/github.com/gin-gonic/gin@v1.9.1"), {
      ecosystem: "Go",
      name: "github.com/gin-gonic/gin",
      version: "v1.9.1",
    });
  });

  test("Maven joins group and artifact with a colon, as OSV expects", () => {
    assert.deepEqual(parsePurl("pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1"), {
      ecosystem: "Maven",
      name: "org.apache.logging.log4j:log4j-core",
      version: "2.14.1",
    });
  });

  test("PyPI names are normalised, so Django_Rest.Framework and its registry name match", () => {
    assert.equal(parsePurl("pkg:pypi/Django_REST.Framework@3.14.0")!.name, "django-rest-framework");
    assert.equal(normalizePypiName("typing_extensions"), "typing-extensions");
  });

  test("Composer and GitHub Actions keep vendor and owner", () => {
    assert.equal(parsePurl("pkg:composer/symfony/http-kernel@6.4.0")!.name, "symfony/http-kernel");
    assert.deepEqual(parsePurl("pkg:githubactions/actions/checkout@6.*.*"), {
      ecosystem: "GitHub Actions",
      name: "actions/checkout",
      version: "6.*.*",
    });
  });

  test("Cargo, RubyGems and NuGet map to the names OSV uses", () => {
    assert.equal(parsePurl("pkg:cargo/serde@1.0.200")!.ecosystem, "crates.io");
    assert.equal(parsePurl("pkg:gem/rails@7.1.3")!.ecosystem, "RubyGems");
    assert.equal(parsePurl("pkg:nuget/Newtonsoft.Json@13.0.3")!.ecosystem, "NuGet");
  });

  test("qualifiers and subpaths do not leak into the version", () => {
    assert.equal(parsePurl("pkg:npm/left-pad@1.3.0?vcs_url=git%2Bhttps://x#lib")!.version, "1.3.0");
  });

  test("unknown types and malformed input return null rather than a wrong guess", () => {
    assert.equal(parsePurl("pkg:github/sindresorhus/is@main"), null);
    assert.equal(parsePurl("pkg:docker/library/node@20"), null);
    assert.equal(parsePurl("lodash@4.17.20"), null);
    assert.equal(parsePurl("pkg:npm"), null);
    assert.equal(parsePurl(""), null);
  });
});

describe("isPinned", () => {
  test("exact versions in each ecosystem's style", () => {
    for (const v of ["1.2.3", "v1.9.1", "2.0.0-rc.1", "1.0.0+build.5", "v0.0.0-20210101000000-abcdef123456", "31.1-jre", "1.0.0.post1", "13.0.3", "7"]) {
      assert.equal(isPinned(v), true, v);
    }
  });

  test("ranges, wildcards and branch names are not versions", () => {
    for (const v of ["^4.17.0", "~1.2.3", ">=2.0.0", "1.x", "6.*.*", "*", "1.2.3 || 2.0.0", ">=1.0,<2.0", "latest", "main", ""]) {
      assert.equal(isPinned(v), false, v);
    }
  });
});

describe("packageKey", () => {
  test("is stable across PyPI spellings and distinct across ecosystems", () => {
    assert.equal(packageKey("PyPI", "Typing_Extensions"), packageKey("PyPI", "typing-extensions"));
    assert.notEqual(packageKey("npm", "requests"), packageKey("PyPI", "requests"));
  });
});

describe("cvss3BaseScore", () => {
  // Published scores for real advisories and the specification's own examples.
  const known: [string, number][] = [
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0], // Log4Shell
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L", 5.3], // lodash ReDoS
    ["CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H", 7.2], // lodash command injection
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1], // reflected XSS
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8],
    ["CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H", 8.1],
    ["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 9.9],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5],
    ["CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 1.6], // the lowest non-zero score
  ];

  for (const [vector, expected] of known) {
    test(`${vector} is ${expected.toFixed(1)}`, () => {
      assert.equal(cvss3BaseScore(vector), expected);
    });
  }

  test("no impact means a score of zero", () => {
    assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"), 0);
  });

  test("temporal and environmental metrics after the base ones are ignored", () => {
    assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O"), 9.8);
  });

  test("anything that is not a complete v3 vector returns null", () => {
    assert.equal(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), null);
    assert.equal(cvss3BaseScore("CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P"), null);
    assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L"), null);
    assert.equal(cvss3BaseScore("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), null);
    assert.equal(cvss3BaseScore(""), null);
  });

  test("never leaves the 0 to 10 range", () => {
    for (const av of ["N", "A", "L", "P"]) for (const pr of ["N", "L", "H"]) for (const s of ["U", "C"]) for (const c of ["H", "L", "N"]) {
      const score = cvss3BaseScore(`CVSS:3.1/AV:${av}/AC:L/PR:${pr}/UI:N/S:${s}/C:${c}/I:H/A:H`)!;
      assert.ok(score >= 0 && score <= 10, `${score}`);
    }
  });
});

describe("severity", () => {
  test("bands follow the specification", () => {
    assert.equal(severityFromScore(9.0), "critical");
    assert.equal(severityFromScore(8.9), "high");
    assert.equal(severityFromScore(7.0), "high");
    assert.equal(severityFromScore(6.9), "moderate");
    assert.equal(severityFromScore(4.0), "moderate");
    assert.equal(severityFromScore(3.9), "low");
    assert.equal(severityFromScore(0), "unknown");
    assert.equal(severityFromScore(null), "unknown");
  });

  test("labels are read case-insensitively, and MEDIUM means moderate", () => {
    assert.equal(severityFromLabel("CRITICAL"), "critical");
    assert.equal(severityFromLabel("MODERATE"), "moderate");
    assert.equal(severityFromLabel("Medium"), "moderate");
    assert.equal(severityFromLabel(undefined), "unknown");
    assert.equal(severityFromLabel("spicy"), "unknown");
  });
});
