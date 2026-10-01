import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseSpdx } from "@/lib/guard/sbom";
import {
  declaredCargo,
  declaredPython,
  dedupe,
  isIgnoredPath,
  isManifestPath,
  parseCargoLock,
  parseComposerLock,
  parseGemfileLock,
  parseGoMod,
  parseManifests,
  parsePackageLock,
  parsePipfileLock,
  parsePnpmLock,
  parsePythonLock,
  parseRequirements,
  parseYarnLock,
  splitPnpmKey,
} from "@/lib/guard/lockfiles";
import type { Dependency } from "@/lib/guard/types";

const find = (deps: Dependency[], name: string, version?: string) =>
  deps.find((d) => d.name === name && (version === undefined || d.version === version));

const PACKAGE_JSON = JSON.stringify({
  dependencies: { next: "^16.0.0", lodash: "^4.17.20" },
  devDependencies: { typescript: "^5" },
});

describe("parseSpdx", () => {
  const pkg = (id: string, purl: string, versionInfo = "") => ({
    SPDXID: id,
    versionInfo,
    externalRefs: [{ referenceType: "purl", referenceLocator: purl }],
  });

  test("with a graph, only what the repo depends on directly is direct", () => {
    const deps = parseSpdx({
      packages: [
        pkg("root", "pkg:github/acme/app@main"),
        pkg("a", "pkg:npm/express@4.19.2"),
        pkg("b", "pkg:npm/qs@6.11.0"),
        pkg("c", "pkg:npm/%40types/node@20.14.10"),
      ],
      relationships: [
        { spdxElementId: "SPDXRef-DOCUMENT", relatedSpdxElement: "root", relationshipType: "DESCRIBES" },
        { spdxElementId: "root", relatedSpdxElement: "a", relationshipType: "DEPENDS_ON" },
        { spdxElementId: "root", relatedSpdxElement: "c", relationshipType: "DEPENDS_ON" },
        { spdxElementId: "a", relatedSpdxElement: "b", relationshipType: "DEPENDS_ON" },
      ],
    });

    assert.equal(deps.length, 3, "the repository itself is not one of its dependencies");
    assert.equal(find(deps, "express")!.direct, true);
    assert.equal(find(deps, "qs")!.direct, false);
    assert.equal(find(deps, "@types/node")!.direct, true);
    assert.ok(deps.every((d) => d.pinned));
  });

  test("without a lockfile, versions are ranges and are marked unpinned", () => {
    const deps = parseSpdx({
      packages: [pkg("root", "pkg:github/acme/app@main"), pkg("a", "pkg:npm/xo@%5E0.58.0", "^0.58.0")],
      relationships: [{ spdxElementId: "root", relatedSpdxElement: "a", relationshipType: "DEPENDS_ON" }],
    });
    assert.equal(deps[0].version, "^0.58.0");
    assert.equal(deps[0].pinned, false);
  });

  test("an export with no edges treats what it lists as declared", () => {
    const deps = parseSpdx({ packages: [pkg("a", "pkg:pypi/requests@2.31.0")] });
    assert.equal(deps[0].direct, true);
    assert.equal(deps[0].ecosystem, "PyPI");
  });

  test("the same package from two manifests appears once, direct if either says so", () => {
    const deps = parseSpdx({
      packages: [
        pkg("root", "pkg:github/acme/app@main"),
        pkg("a1", "pkg:npm/ms@2.1.3"),
        pkg("a2", "pkg:npm/ms@2.1.3"),
        pkg("x", "pkg:npm/debug@4.3.4"),
      ],
      relationships: [
        { spdxElementId: "root", relatedSpdxElement: "x", relationshipType: "DEPENDS_ON" },
        { spdxElementId: "x", relatedSpdxElement: "a1", relationshipType: "DEPENDS_ON" },
        { spdxElementId: "root", relatedSpdxElement: "a2", relationshipType: "DEPENDS_ON" },
      ],
    });
    assert.equal(deps.filter((d) => d.name === "ms").length, 1);
    assert.equal(find(deps, "ms")!.direct, true);
  });

  test("packages it cannot identify are skipped, not guessed", () => {
    assert.deepEqual(parseSpdx({ packages: [{ SPDXID: "x", name: "mystery" }, pkg("d", "pkg:docker/node@20")] }), []);
    assert.deepEqual(parseSpdx({}), []);
  });
});

describe("parsePackageLock", () => {
  const lockV3 = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { next: "^16.0.0", lodash: "^4.17.20" }, devDependencies: { typescript: "^5" } },
      "node_modules/next": { version: "16.3.8" },
      "node_modules/lodash": { version: "4.17.21" },
      "node_modules/typescript": { version: "5.9.3", dev: true },
      "node_modules/@swc/helpers": { version: "0.5.15" },
      "node_modules/next/node_modules/lodash": { version: "4.17.20" },
      "node_modules/@acme/shared": { resolved: "packages/shared", link: true },
      "packages/api": { version: "1.0.0", dependencies: { fastify: "^5.0.0" } },
      "node_modules/fastify": { version: "5.1.0" },
      "packages/api/node_modules/lodash": { version: "3.10.1" },
    },
  });

  test("v3: resolved versions, with direct, transitive and dev told apart", () => {
    const deps = parsePackageLock(lockV3, "package-lock.json", PACKAGE_JSON);

    assert.deepEqual(
      { ...find(deps, "next") },
      { ecosystem: "npm", name: "next", version: "16.3.8", pinned: true, direct: true, scope: "runtime", manifest: "package-lock.json" }
    );
    assert.equal(find(deps, "typescript")!.scope, "dev");
    assert.equal(find(deps, "@swc/helpers")!.direct, false, "scoped names are read whole, and this one is transitive");
  });

  test("v3: a copy nested under another package is that package's, not the repo's", () => {
    const deps = parsePackageLock(lockV3, "package-lock.json", PACKAGE_JSON);
    assert.equal(find(deps, "lodash", "4.17.21")!.direct, true);
    assert.equal(find(deps, "lodash", "4.17.20")!.direct, false);
  });

  test("v3: a workspace's own dependencies count as direct, and its links are not installs", () => {
    const deps = parsePackageLock(lockV3, "package-lock.json", PACKAGE_JSON);
    assert.equal(find(deps, "fastify")!.direct, true);
    assert.equal(find(deps, "lodash", "3.10.1")!.direct, true, "a workspace pinned its own version");
    assert.equal(find(deps, "@acme/shared"), undefined);
    assert.equal(find(deps, "api"), undefined, "a workspace package is not a dependency");
  });

  test("v1: the nested tree is walked, and only its top level can be direct", () => {
    const lockV1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21" },
        next: { version: "16.3.8", dependencies: { lodash: { version: "4.17.20" } } },
        typescript: { version: "5.9.3", dev: true },
      },
    });
    const deps = parsePackageLock(lockV1, "package-lock.json", PACKAGE_JSON);
    assert.equal(deps.length, 4);
    assert.equal(find(deps, "lodash", "4.17.21")!.direct, true);
    assert.equal(find(deps, "lodash", "4.17.20")!.direct, false);
    assert.equal(find(deps, "typescript")!.scope, "dev");
  });

  test("a corrupt lockfile yields nothing rather than throwing", () => {
    assert.deepEqual(parsePackageLock("{not json", "package-lock.json"), []);
  });
});

describe("pnpm", () => {
  test("splitPnpmKey reads all three key generations", () => {
    assert.deepEqual(splitPnpmKey("/next/13.4.0", 5), ["next", "13.4.0"]);
    assert.deepEqual(splitPnpmKey("/@babel/core/7.24.0", 5), ["@babel/core", "7.24.0"]);
    assert.deepEqual(splitPnpmKey("/react-dom/18.2.0_react@18.2.0", 5), ["react-dom", "18.2.0"]);

    assert.deepEqual(splitPnpmKey("/next@13.4.0(react@18.2.0)", 6), ["next", "13.4.0"]);
    assert.deepEqual(splitPnpmKey("/@babel/core@7.24.0", 6), ["@babel/core", "7.24.0"]);

    assert.deepEqual(splitPnpmKey("next@16.3.8", 9), ["next", "16.3.8"]);
    assert.deepEqual(splitPnpmKey("'@babel/core@7.24.0'", 9), ["@babel/core", "7.24.0"]);
    assert.equal(splitPnpmKey("", 9), null);
  });

  const lockV9 = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      lodash:",
    "        specifier: ^4.17.20",
    "        version: 4.17.21",
    "      next:",
    "        specifier: ^16.0.0",
    "        version: 16.3.8(react@19.3.0)",
    "    devDependencies:",
    "      typescript:",
    "        specifier: ^5",
    "        version: 5.9.3",
    "",
    "  packages/api:",
    "    dependencies:",
    "      '@acme/shared':",
    "        specifier: workspace:*",
    "        version: link:../shared",
    "      lodash:",
    "        specifier: 3.10.1",
    "        version: 3.10.1",
    "",
    "packages:",
    "",
    "  '@swc/helpers@0.5.15':",
    "    resolution: {integrity: sha512-x}",
    "",
    "  lodash@3.10.1:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  lodash@4.17.21:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  next@16.3.8:",
    "    resolution: {integrity: sha512-x}",
    "    engines: {node: '>=20'}",
    "",
    "  typescript@5.9.3:",
    "    resolution: {integrity: sha512-x}",
    "",
    "snapshots:",
    "",
    "  next@16.3.8(react@19.3.0):",
    "    dependencies:",
    "      '@swc/helpers': 0.5.15",
  ].join("\n");

  test("v9: packages come from `packages`, and importers say which are direct", () => {
    const deps = parsePnpmLock(lockV9, "pnpm-lock.yaml", PACKAGE_JSON);
    assert.equal(deps.length, 5, "snapshots repeat the packages and are not read");
    assert.equal(find(deps, "next")!.version, "16.3.8");
    assert.equal(find(deps, "next")!.direct, true);
    assert.equal(find(deps, "typescript")!.scope, "dev");
    assert.equal(find(deps, "@swc/helpers")!.direct, false);
  });

  test("v9: every workspace package's choices are direct, and workspace links are ignored", () => {
    const deps = parsePnpmLock(lockV9, "pnpm-lock.yaml", PACKAGE_JSON);
    assert.equal(find(deps, "lodash", "4.17.21")!.direct, true);
    assert.equal(find(deps, "lodash", "3.10.1")!.direct, true);
    assert.equal(find(deps, "@acme/shared"), undefined);
  });

  test("v6 single package: groups at the top level, keys with a leading slash", () => {
    const lock = [
      "lockfileVersion: '6.0'",
      "",
      "dependencies:",
      "  next:",
      "    specifier: ^13",
      "    version: 13.4.0(react@18.2.0)",
      "",
      "devDependencies:",
      "  typescript:",
      "    specifier: ^5",
      "    version: 5.0.4",
      "",
      "packages:",
      "",
      "  /next@13.4.0(react@18.2.0):",
      "    resolution: {integrity: sha512-x}",
      "",
      "  /scheduler@0.23.0:",
      "    resolution: {integrity: sha512-x}",
      "",
      "  /typescript@5.0.4:",
      "    resolution: {integrity: sha512-x}",
    ].join("\n");
    const deps = parsePnpmLock(lock, "pnpm-lock.yaml");
    assert.deepEqual(deps.map((d) => `${d.name}@${d.version}:${d.direct}:${d.scope}`), [
      "next@13.4.0:true:runtime",
      "scheduler@0.23.0:false:unknown",
      "typescript@5.0.4:true:dev",
    ]);
  });

  test("v5: slash-separated keys and one-line versions", () => {
    const lock = [
      "lockfileVersion: 5.4",
      "",
      "dependencies:",
      "  react-dom: 18.2.0_react@18.2.0",
      "",
      "packages:",
      "",
      "  /react-dom/18.2.0_react@18.2.0:",
      "    resolution: {integrity: sha512-x}",
      "",
      "  /@babel/core/7.24.0:",
      "    resolution: {integrity: sha512-x}",
    ].join("\n");
    const deps = parsePnpmLock(lock, "pnpm-lock.yaml");
    assert.equal(find(deps, "react-dom")!.version, "18.2.0");
    assert.equal(find(deps, "react-dom")!.direct, true);
    assert.equal(find(deps, "@babel/core")!.version, "7.24.0");
  });
});

describe("parseYarnLock", () => {
  test("classic: several ranges can resolve to one entry", () => {
    const lock = [
      "# yarn lockfile v1",
      "",
      '"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":',
      '  version "7.12.13"',
      '  resolved "https://registry.yarnpkg.com/..."',
      "",
      "lodash@^4.17.20:",
      '  version "4.17.21"',
      "",
      "lodash@^3.0.0:",
      '  version "3.10.1"',
    ].join("\n");
    const deps = parseYarnLock(lock, "yarn.lock", PACKAGE_JSON);
    assert.equal(find(deps, "@babel/code-frame")!.version, "7.12.13");
    assert.equal(find(deps, "lodash", "4.17.21")!.direct, true, "this is the range package.json asked for");
    assert.equal(find(deps, "lodash", "3.10.1")!.direct, false, "same name, but somebody else's range");
  });

  test("berry: the npm: protocol and unquoted versions", () => {
    const lock = [
      "__metadata:",
      "  version: 8",
      "",
      '"lodash@npm:^4.17.20":',
      "  version: 4.17.21",
      '  resolution: "lodash@npm:4.17.21"',
      "",
      '"typescript@npm:^5":',
      "  version: 5.9.3",
    ].join("\n");
    const deps = parseYarnLock(lock, "yarn.lock", PACKAGE_JSON);
    assert.equal(deps.length, 2, "the metadata block is not a package");
    assert.equal(find(deps, "lodash")!.direct, true);
    assert.equal(find(deps, "typescript")!.scope, "dev");
  });
});

describe("Python", () => {
  test("requirements.txt: pins, extras, markers, hashes and things that are not packages", () => {
    const deps = parseRequirements(
      [
        "# a comment",
        "-r base.txt",
        "-e .",
        "requests==2.31.0",
        "uvicorn[standard]==0.30.1 ; python_version >= '3.8'",
        "Django_Rest.Framework==3.15.2 \\",
        "    --hash=sha256:abc",
        "rich>=13.0",
        "pytest",
        "git+https://github.com/acme/thing.git#egg=thing",
      ].join("\n"),
      "requirements.txt"
    );
    assert.deepEqual(
      deps.map((d) => `${d.name}@${d.version}:${d.pinned}`),
      ["requests@2.31.0:true", "uvicorn@0.30.1:true", "django-rest-framework@3.15.2:true", "rich@>=13.0:false", "pytest@:false"]
    );
  });

  test("a dev requirements file is dev scope", () => {
    assert.equal(parseRequirements("pytest==8.2.0", "requirements-dev.txt")[0].scope, "dev");
    assert.equal(parseRequirements("flask==3.0.3", "requirements.txt")[0].scope, "runtime");
  });

  test("pip-compile output: a pin that is only there via another package is transitive", () => {
    const deps = parseRequirements(
      [
        "flask==3.0.3",
        "    # via -r requirements.in",
        "jinja2==3.1.4",
        "    # via flask",
        "markupsafe==2.1.5",
        "    # via",
        "    #   jinja2",
        "    #   werkzeug",
      ].join("\n"),
      "requirements.txt"
    );
    assert.equal(find(deps, "flask")!.direct, true);
    assert.equal(find(deps, "jinja2")!.direct, false);
    assert.equal(find(deps, "markupsafe")!.direct, false);
  });

  test("declaredPython reads dependency tables and nothing else", () => {
    const names = declaredPython(
      [
        "[project]",
        'name = "acme"',
        'authors = [{ name = "Ada" }]',
        'classifiers = ["Programming Language :: Python"]',
        "dependencies = [",
        '  "requests>=2.0",',
        '  "Typing_Extensions",',
        "]",
        "",
        "[project.optional-dependencies]",
        'dev = ["pytest>=8"]',
        "",
        "[dependency-groups]",
        'lint = ["ruff"]',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'httpx = "^0.27"',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'mypy = "^1.10"',
        "",
        "[tool.ruff]",
        'select = ["E", "F"]',
      ].join("\n")
    );
    assert.deepEqual([...names].sort(), ["httpx", "mypy", "pytest", "requests", "ruff", "typing-extensions"]);
  });

  test("poetry.lock and uv.lock: packages, with direct taken from pyproject", () => {
    const lock = [
      "[[package]]",
      'name = "requests"',
      'version = "2.31.0"',
      'groups = ["main"]',
      "",
      "[package.dependencies]",
      'name = "should-not-be-read"',
      "",
      "[[package]]",
      'name = "urllib3"',
      'version = "2.2.2"',
      'groups = ["main"]',
      "",
      "[[package]]",
      'name = "pytest"',
      'version = "8.2.0"',
      'groups = ["dev"]',
      "",
      "[[package]]",
      'name = "old-style-dev"',
      'version = "1.0.0"',
      'category = "dev"',
    ].join("\n");
    const deps = parsePythonLock(lock, "poetry.lock", '[project]\ndependencies = ["requests"]');
    assert.equal(deps.length, 4);
    assert.equal(find(deps, "requests")!.direct, true);
    assert.equal(find(deps, "urllib3")!.direct, false);
    assert.equal(find(deps, "pytest")!.scope, "dev");
    assert.equal(find(deps, "old-style-dev")!.scope, "dev");
    assert.equal(find(deps, "should-not-be-read"), undefined);
  });

  test("Pipfile.lock: default and develop sections", () => {
    const deps = parsePipfileLock(
      JSON.stringify({ default: { requests: { version: "==2.31.0" } }, develop: { pytest: { version: "==8.2.0" } } }),
      "Pipfile.lock"
    );
    assert.deepEqual(deps.map((d) => `${d.name}@${d.version}:${d.scope}`), ["requests@2.31.0:runtime", "pytest@8.2.0:dev"]);
  });
});

describe("Go, Rust, Ruby, PHP", () => {
  test("go.mod: block and single-line requires, with indirect ones marked", () => {
    const deps = parseGoMod(
      [
        "module github.com/acme/app",
        "",
        "go 1.22",
        "",
        "require github.com/spf13/cobra v1.8.1",
        "",
        "require (",
        "\tgithub.com/gin-gonic/gin v1.9.1",
        "\tgolang.org/x/crypto v0.17.0 // indirect",
        "\tgolang.org/x/sys v0.0.0-20240101000000-abcdef123456 // indirect",
        ")",
        "",
        "replace example.com/x => ../x",
      ].join("\n"),
      "go.mod"
    );
    assert.deepEqual(
      deps.map((d) => `${d.name}@${d.version}:${d.direct}`),
      [
        "github.com/spf13/cobra@v1.8.1:true",
        "github.com/gin-gonic/gin@v1.9.1:true",
        "golang.org/x/crypto@v0.17.0:false",
        "golang.org/x/sys@v0.0.0-20240101000000-abcdef123456:false",
      ]
    );
    assert.ok(deps.every((d) => d.pinned && d.ecosystem === "Go"));
  });

  test("declaredCargo reads every way Cargo.toml can declare a dependency", () => {
    const declared = declaredCargo(
      [
        "[package]",
        'name = "app"',
        "",
        "[dependencies]",
        'serde = { version = "1", features = ["derive"] }',
        'tokio = "1"',
        "",
        "[dependencies.reqwest]",
        'version = "0.12"',
        "",
        "[dev-dependencies]",
        'insta = "1"',
        "",
        "[target.'cfg(unix)'.dependencies]",
        'nix = "0.29"',
        "",
        "[build-dependencies]",
        'cc = "1"',
      ].join("\n")
    );
    assert.deepEqual([...declared.runtime].sort(), ["cc", "nix", "reqwest", "serde", "tokio"]);
    assert.deepEqual([...declared.dev], ["insta"]);
  });

  test("Cargo.lock: workspace crates are skipped, registry crates are kept", () => {
    const lock = [
      "version = 3",
      "",
      "[[package]]",
      'name = "app"',
      'version = "0.1.0"',
      "dependencies = [",
      ' "serde",',
      "]",
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.203"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "itoa"',
      'version = "1.0.11"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join("\n");
    const deps = parseCargoLock(lock, "Cargo.lock", '[dependencies]\nserde = "1"');
    assert.deepEqual(deps.map((d) => `${d.name}@${d.version}:${d.direct}`), ["serde@1.0.203:true", "itoa@1.0.11:false"]);
    assert.equal(deps[0].ecosystem, "crates.io");
  });

  test("Gemfile.lock: resolved gems, their requirements ignored, platforms stripped", () => {
    const lock = [
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    actionpack (7.1.3)",
      "      rack (>= 2.2.4)",
      "    nokogiri (1.16.5-x86_64-linux)",
      "    rack (3.0.11)",
      "    rails (7.1.3)",
      "      actionpack (= 7.1.3)",
      "",
      "PLATFORMS",
      "  x86_64-linux",
      "",
      "DEPENDENCIES",
      "  nokogiri",
      "  rails (~> 7.1.3)",
      "",
      "BUNDLED WITH",
      "   2.5.9",
    ].join("\n");
    const deps = parseGemfileLock(lock, "Gemfile.lock");
    assert.deepEqual(
      deps.map((d) => `${d.name}@${d.version}:${d.direct}`),
      ["actionpack@7.1.3:false", "nokogiri@1.16.5:true", "rack@3.0.11:false", "rails@7.1.3:true"]
    );
  });

  test("composer.lock: both sections, with the tag prefix removed", () => {
    const deps = parseComposerLock(
      JSON.stringify({
        packages: [
          { name: "symfony/http-kernel", version: "v6.4.8" },
          { name: "psr/log", version: "3.0.0" },
        ],
        "packages-dev": [{ name: "phpunit/phpunit", version: "11.2.1" }],
      }),
      "composer.lock",
      JSON.stringify({ require: { "symfony/http-kernel": "^6.4" }, "require-dev": { "phpunit/phpunit": "^11" } })
    );
    assert.deepEqual(
      deps.map((d) => `${d.name}@${d.version}:${d.direct}:${d.scope}`),
      ["symfony/http-kernel@6.4.8:true:runtime", "psr/log@3.0.0:false:runtime", "phpunit/phpunit@11.2.1:true:dev"]
    );
    assert.equal(deps[0].ecosystem, "Packagist");
  });
});

describe("which files to read", () => {
  test("isManifestPath recognises lockfiles and requirements variants", () => {
    for (const path of ["package-lock.json", "apps/web/pnpm-lock.yaml", "go.mod", "requirements.txt", "requirements-dev.txt", "requirements/prod.txt", "services/api/Cargo.lock"]) {
      assert.equal(isManifestPath(path), true, path);
    }
    for (const path of ["README.md", "src/index.ts", "docs/requirements.md", "notes.txt", "package.json.bak"]) {
      assert.equal(isManifestPath(path), false, path);
    }
  });

  test("isIgnoredPath skips vendored code and fixtures", () => {
    for (const path of ["node_modules/x/package.json", "vendor/github.com/x/go.mod", "tests/fixtures/app/package-lock.json", "examples/demo/yarn.lock", "a/b/testdata/go.mod"]) {
      assert.equal(isIgnoredPath(path), true, path);
    }
    for (const path of ["package-lock.json", "apps/web/package.json", "services/vendoring/go.mod"]) {
      assert.equal(isIgnoredPath(path), false, path);
    }
  });
});

describe("parseManifests", () => {
  test("reads a lockfile alongside its manifest", () => {
    const result = parseManifests([
      { path: "package.json", content: PACKAGE_JSON },
      {
        path: "package-lock.json",
        content: JSON.stringify({
          lockfileVersion: 3,
          packages: { "": {}, "node_modules/next": { version: "16.3.8" }, "node_modules/ms": { version: "2.1.3" } },
        }),
      },
    ]);
    assert.deepEqual(result.manifests, ["package-lock.json"]);
    assert.deepEqual(result.notes, []);
    assert.equal(find(result.dependencies, "next")!.direct, true);
    assert.equal(find(result.dependencies, "ms")!.direct, false);
  });

  test("a package.json with no lockfile is reported, with its ranges marked unpinned", () => {
    const result = parseManifests([{ path: "package.json", content: PACKAGE_JSON }]);
    assert.equal(result.dependencies.length, 3);
    assert.ok(result.dependencies.every((d) => !d.pinned && d.direct));
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0], /no lockfile/);
  });

  test("a workspace member is covered by the lockfile at the root", () => {
    const result = parseManifests([
      { path: "package.json", content: "{}" },
      { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n\npackages:\n\n  ms@2.1.3:\n    resolution: {}\n" },
      { path: "apps/web/package.json", content: PACKAGE_JSON },
    ]);
    assert.deepEqual(result.notes, []);
    assert.equal(result.dependencies.length, 1);
  });

  test("each directory in a monorepo is read with its own manifest", () => {
    const result = parseManifests([
      { path: "services/api/go.mod", content: "require github.com/gin-gonic/gin v1.9.1" },
      { path: "services/ml/requirements.txt", content: "numpy==2.0.0" },
      { path: "services/ml/requirements/dev.txt", content: "pytest==8.2.0" },
      { path: "node_modules/x/package.json", content: PACKAGE_JSON },
    ]);
    assert.deepEqual(result.manifests.sort(), [
      "services/api/go.mod",
      "services/ml/requirements.txt",
      "services/ml/requirements/dev.txt",
    ]);
    assert.deepEqual(result.dependencies.map((d) => d.ecosystem).sort(), ["Go", "PyPI", "PyPI"]);
  });

  test("nothing readable gives an empty inventory", () => {
    assert.deepEqual(parseManifests([]), { dependencies: [], manifests: [], notes: [] });
  });
});

describe("dedupe", () => {
  const base: Dependency = { ecosystem: "npm", name: "ms", version: "2.1.3", pinned: true, direct: false, scope: "unknown" };

  test("one entry per package version", () => {
    assert.equal(dedupe([base, { ...base }, { ...base, version: "2.0.0" }]).length, 2);
  });

  test("direct anywhere is direct, and runtime wins over dev", () => {
    const [merged] = dedupe([{ ...base, scope: "dev" }, { ...base, direct: true, scope: "runtime" }, { ...base, scope: "dev" }]);
    assert.equal(merged.direct, true);
    assert.equal(merged.scope, "runtime");
  });

  test("PyPI spellings of one name are the same package", () => {
    const py = { ...base, ecosystem: "PyPI" as const };
    assert.equal(dedupe([{ ...py, name: "typing_extensions" }, { ...py, name: "typing-extensions" }]).length, 1);
  });
});
