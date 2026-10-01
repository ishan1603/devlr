import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildInventory } from "@/lib/guard/inventory";
import {
  declaredCargo,
  isManifestPath,
  parseBunLock,
  parseCargoLock,
  parseComposerLock,
  parseGoMod,
  parseManifests,
  parsePackageLock,
  parsePnpmLock,
  parsePythonLock,
  parseYarnLock,
} from "@/lib/guard/lockfiles";
import { dropRedundantRanges, parseSpdx } from "@/lib/guard/sbom";
import type { Dependency } from "@/lib/guard/types";

/**
 * Workspaces, and everything in a lockfile that is not a registry package.
 *
 * Both are about the same mistake in opposite directions: missing a package
 * the repo really depends on, or accusing the repo's own code of a stranger's
 * bug because the names happen to match.
 */

const find = (deps: Dependency[], name: string, version?: string) =>
  deps.find((d) => d.name === name && (version === undefined || d.version === version));
const names = (deps: Dependency[]) => deps.map((d) => d.name).sort();

const REGISTRY = 'source = "registry+https://github.com/rust-lang/crates.io-index"';

describe("bun.lock", () => {
  const lock = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "react": "^19.0.0",
        "pad": "npm:left-pad@^1.3.0",
      },
      "devDependencies": {
        "typescript": "^5",
      },
    },
    "packages/ui": {
      "name": "@acme/ui",
      "dependencies": {
        "clsx": "^2.1.0",
      },
    },
  },
  "packages": {
    "react": ["react@19.0.0", "", {}, "sha512-aaa"],
    "typescript": ["typescript@5.9.3", "", { "bin": { "tsc": "bin/tsc" } }, "sha512-bbb"],
    "clsx": ["clsx@2.1.1", "", {}, "sha512-ccc"],
    "@acme/ui": ["@acme/ui@workspace:packages/ui"],
    "@types/node": ["@types/node@22.10.2", "", { "dependencies": { "undici-types": "~6.20.0" } }, "sha512-ddd"],
    "string-width/strip-ansi": ["strip-ansi@6.0.1", "", {}, "sha512-eee"],
    "pad": ["left-pad@1.3.0", "", {}, "sha512-fff"],
    "forked": ["forked@github:acme/forked#abc1234", {}, "acme-forked-abc1234"],
  },
}
`;
  const deps = parseBunLock(lock, "bun.lock");

  test("reads resolved versions through the trailing commas", () => {
    assert.deepEqual(names(deps), ["@types/node", "clsx", "left-pad", "react", "strip-ansi", "typescript"]);
    assert.ok(deps.every((d) => d.ecosystem === "npm" && d.pinned && d.manifest === "bun.lock"));
  });

  test("what any workspace asked for is direct, with its scope", () => {
    assert.deepEqual([find(deps, "react")!.direct, find(deps, "react")!.scope], [true, "runtime"]);
    assert.deepEqual([find(deps, "typescript")!.direct, find(deps, "typescript")!.scope], [true, "dev"]);
    assert.deepEqual([find(deps, "clsx")!.direct, find(deps, "clsx")!.scope], [true, "runtime"]);
  });

  test("a scoped name at the top level is not mistaken for a nested copy", () => {
    assert.deepEqual([find(deps, "@types/node")!.direct, find(deps, "@types/node")!.scope], [false, "unknown"]);
  });

  test("a copy under another package's path belongs to that package", () => {
    assert.equal(find(deps, "strip-ansi")!.direct, false);
  });

  test("an alias is reported under the package it really installs", () => {
    assert.deepEqual([find(deps, "left-pad")!.version, find(deps, "left-pad")!.direct], ["1.3.0", true]);
    assert.equal(find(deps, "pad"), undefined);
  });

  test("workspace packages and git installs are not registry packages", () => {
    assert.equal(find(deps, "@acme/ui"), undefined);
    assert.equal(find(deps, "forked"), undefined);
  });

  test("anything that is not a bun lockfile yields nothing", () => {
    assert.deepEqual(parseBunLock("not json", "bun.lock"), []);
    assert.deepEqual(parseBunLock("{}", "bun.lock"), []);
  });

  test("it is a manifest worth fetching", () => {
    assert.equal(isManifestPath("apps/web/bun.lock"), true);
  });
});

describe("yarn.lock beyond the simple case", () => {
  const berry = [
    "__metadata:",
    "  version: 8",
    "",
    '"my-app@workspace:.":',
    "  version: 0.0.0-use.local",
    '  resolution: "my-app@workspace:."',
    "",
    '"@acme/ui@workspace:packages/ui":',
    "  version: 0.0.0-use.local",
    "",
    '"resolve@patch:resolve@^1.20.0#~builtin<compat/resolve>":',
    "  version: 1.22.8",
    "",
    '"pad@npm:left-pad@^1.3.0":',
    "  version: 1.3.0",
    '  resolution: "left-pad@npm:1.3.0"',
    "",
    '"@types/alias@npm:@types/node@^22.0.0":',
    "  version: 22.10.2",
    "",
    '"forked@https://github.com/acme/forked.git#commit=abc123":',
    "  version: 2.0.0",
    "",
    '"clsx@npm:^2.1.0, clsx@npm:^2.1.1":',
    "  version: 2.1.1",
  ].join("\n");

  const root = JSON.stringify({ dependencies: { pad: "npm:left-pad@^1.3.0" } });
  const member = JSON.stringify({ dependencies: { clsx: "^2.1.0" }, devDependencies: { resolve: "^9.9.9" } });
  const deps = parseYarnLock(berry, "yarn.lock", [root, member]);

  test("the repo's own workspace packages are not dependencies", () => {
    assert.equal(find(deps, "my-app"), undefined);
    assert.equal(find(deps, "@acme/ui"), undefined);
  });

  test("a patched package is still that package", () => {
    assert.deepEqual([find(deps, "resolve")!.version, find(deps, "resolve")!.pinned], ["1.22.8", true]);
  });

  test("an alias is reported under the package it really installs, scoped or not", () => {
    assert.equal(find(deps, "left-pad")!.version, "1.3.0");
    assert.equal(find(deps, "left-pad")!.direct, true, "package.json asked for it, under the alias");
    assert.equal(find(deps, "@types/node")!.version, "22.10.2");
    assert.equal(find(deps, "pad"), undefined);
    assert.equal(find(deps, "@types/alias"), undefined);
  });

  test("a git install is not a registry package", () => {
    assert.equal(find(deps, "forked"), undefined);
  });

  test("a workspace member's range makes its dependency direct", () => {
    assert.deepEqual([find(deps, "clsx")!.direct, find(deps, "clsx")!.scope], [true, "runtime"]);
  });

  test("a declared name with a different range is somebody else's copy", () => {
    assert.deepEqual([find(deps, "resolve")!.direct, find(deps, "resolve")!.scope], [false, "dev"]);
  });

  test("classic: git remotes and owner/repo shorthands are skipped, aliases resolved", () => {
    const classic = [
      "# yarn lockfile v1",
      "",
      '"forked@git+https://github.com/acme/forked.git#abc":',
      '  version "2.0.0"',
      "",
      "shorthand@acme/shorthand#v1:",
      '  version "1.0.0"',
      "",
      '"pad@npm:left-pad@^1.3.0":',
      '  version "1.3.0"',
      "",
      "ms@^2.1.3:",
      '  version "2.1.3"',
    ].join("\n");
    assert.deepEqual(names(parseYarnLock(classic, "yarn.lock")), ["left-pad", "ms"]);
  });
});

describe("other lockfiles: only what came from a registry", () => {
  test("package-lock.json: git and GitHub tarball installs are skipped", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { ms: "^2", forked: "github:acme/forked" } },
        "node_modules/ms": { version: "2.1.3", resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz" },
        "node_modules/forked": { version: "2.0.0", resolved: "git+ssh://git@github.com/acme/forked.git#abc123" },
        "node_modules/tarball": { version: "1.0.0", resolved: "https://codeload.github.com/acme/tarball/tar.gz/abc123" },
        "node_modules/local": { version: "1.0.0", resolved: "file:../local" },
        "node_modules/no-resolved": { version: "3.0.0" },
      },
    });
    assert.deepEqual(names(parsePackageLock(lock, "package-lock.json")), ["ms", "no-resolved"]);
  });

  test("package-lock.json v1: an entry with a URL for a version is skipped", () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { ms: { version: "2.1.3" }, forked: { version: "github:acme/forked#abc123" } },
    });
    assert.deepEqual(names(parsePackageLock(lock, "package-lock.json")), ["ms"]);
  });

  test("pnpm: a key with a URL where the version goes is skipped", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  ms@2.1.3:",
      "    resolution: {integrity: sha512-x}",
      "",
      "  forked@https://codeload.github.com/acme/forked/tar.gz/abc123:",
      "    resolution: {tarball: https://codeload.github.com/acme/forked/tar.gz/abc123}",
    ].join("\n");
    assert.deepEqual(names(parsePnpmLock(lock, "pnpm-lock.yaml")), ["ms"]);
  });

  test("uv.lock: the project itself and git sources are skipped", () => {
    const lock = [
      "version = 1",
      "",
      "[[package]]",
      'name = "my-app"',
      'version = "0.1.0"',
      'source = { editable = "." }',
      "dependencies = [",
      '    { name = "fastapi" },',
      "]",
      "",
      "[[package]]",
      'name = "shared-lib"',
      'version = "0.1.0"',
      'source = { virtual = "packages/shared" }',
      "",
      "[[package]]",
      'name = "forked"',
      'version = "2.0.0"',
      'source = { git = "https://github.com/acme/forked?rev=abc#abc" }',
      "",
      "[[package]]",
      'name = "fastapi"',
      'version = "0.110.0"',
      'source = { registry = "https://pypi.org/simple" }',
    ].join("\n");
    assert.deepEqual(names(parsePythonLock(lock, "uv.lock")), ["fastapi"]);
  });

  test("poetry.lock: path and git sources are skipped, an index source is kept", () => {
    const lock = [
      "[[package]]",
      'name = "local-lib"',
      'version = "0.1.0"',
      'groups = ["main"]',
      "",
      "[package.source]",
      'type = "directory"',
      'url = "../local-lib"',
      "",
      "[[package]]",
      'name = "forked"',
      'version = "2.0.0"',
      "",
      "[package.dependencies]",
      'requests = "*"',
      "",
      "[package.source]",
      'type = "git"',
      'url = "https://github.com/acme/forked.git"',
      "",
      "[[package]]",
      'name = "mirrored"',
      'version = "1.0.0"',
      "",
      "[package.source]",
      'type = "legacy"',
      'url = "https://pypi.internal/simple"',
      "",
      "[[package]]",
      'name = "requests"',
      'version = "2.32.3"',
    ].join("\n");
    assert.deepEqual(names(parsePythonLock(lock, "poetry.lock")), ["mirrored", "requests"]);
  });

  test("Cargo.lock: a git source is someone's fork, not the registry crate", () => {
    const lock = [
      "[[package]]",
      'name = "serde"',
      'version = "1.0.203"',
      REGISTRY,
      "",
      "[[package]]",
      'name = "forked"',
      'version = "0.3.0"',
      'source = "git+https://github.com/acme/forked?branch=main#abc123"',
      "",
      "[[package]]",
      'name = "sparse-one"',
      'version = "1.0.0"',
      'source = "sparse+https://index.crates.io/"',
    ].join("\n");
    assert.deepEqual(names(parseCargoLock(lock, "Cargo.lock")), ["serde", "sparse-one"]);
  });

  test("go.mod: a module replaced by a directory is the repo's own code", () => {
    const mod = [
      "module example.com/app",
      "",
      "require (",
      "\texample.com/lib v0.0.0",
      "\texample.com/other v0.0.0-00010101000000-000000000000",
      "\tgithub.com/gin-gonic/gin v1.9.1",
      "\tgithub.com/old/dep v1.0.0",
      ")",
      "",
      "replace example.com/lib => ../lib",
      "",
      "replace (",
      "\texample.com/other v0.0.0-00010101000000-000000000000 => ./internal/other",
      "\tgithub.com/old/dep => github.com/new/dep v1.2.0",
      ")",
    ].join("\n");
    assert.deepEqual(names(parseGoMod(mod, "go.mod")), ["github.com/gin-gonic/gin", "github.com/old/dep"]);
  });

  test("composer.lock: a path repository is skipped", () => {
    const lock = JSON.stringify({
      packages: [
        { name: "symfony/console", version: "v6.4.0", dist: { type: "zip" } },
        { name: "acme/local", version: "dev-main", dist: { type: "path", url: "../local" } },
      ],
    });
    assert.deepEqual(names(parseComposerLock(lock, "composer.lock")), ["symfony/console"]);
  });
});

describe("Cargo", () => {
  test("a renamed dependency is declared under its real name", () => {
    const declared = declaredCargo(['[dependencies]', 'log2 = { package = "log", version = "0.4" }', 'serde = "1"'].join("\n"));
    assert.deepEqual([...declared.runtime].sort(), ["log", "serde"]);
  });

  test("several manifests can stand behind one lockfile", () => {
    const lock = ["[[package]]", 'name = "serde"', 'version = "1.0.203"', REGISTRY, "", "[[package]]", 'name = "insta"', 'version = "1.39.0"', REGISTRY].join("\n");
    const deps = parseCargoLock(lock, "Cargo.lock", ['[dependencies]\nserde = "1"', '[dev-dependencies]\ninsta = "1"']);
    assert.deepEqual([find(deps, "serde")!.direct, find(deps, "serde")!.scope], [true, "runtime"]);
    assert.deepEqual([find(deps, "insta")!.direct, find(deps, "insta")!.scope], [true, "dev"]);
  });
});

describe("parseManifests in a workspace", () => {
  test("Cargo: every member crate's Cargo.toml counts towards what is direct", () => {
    const result = parseManifests([
      { path: "Cargo.toml", content: '[workspace]\nmembers = ["crates/*"]\n' },
      {
        path: "Cargo.lock",
        content: ["serde", "itoa", "insta"].map((n) => `[[package]]\nname = "${n}"\nversion = "1.0.0"\n${REGISTRY}\n`).join("\n"),
      },
      { path: "crates/core/Cargo.toml", content: '[dependencies]\nserde = "1"\n\n[dev-dependencies]\ninsta = "1"\n' },
    ]);
    assert.deepEqual(result.manifests, ["Cargo.lock"]);
    assert.equal(find(result.dependencies, "serde")!.direct, true);
    assert.deepEqual([find(result.dependencies, "insta")!.direct, find(result.dependencies, "insta")!.scope], [true, "dev"]);
    assert.equal(find(result.dependencies, "itoa")!.direct, false);
  });

  test("uv: a workspace member's pyproject.toml counts too", () => {
    const pkg = (name: string) => `[[package]]\nname = "${name}"\nversion = "1.0.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
    const result = parseManifests([
      { path: "pyproject.toml", content: '[project]\ndependencies = ["fastapi>=0.110"]\n' },
      { path: "uv.lock", content: ["fastapi", "starlette", "numpy"].map(pkg).join("\n") },
      { path: "packages/ml/pyproject.toml", content: '[project]\ndependencies = ["numpy>=2"]\n' },
    ]);
    assert.deepEqual(
      result.dependencies.map((d) => `${d.name}:${d.direct}`).sort(),
      ["fastapi:true", "numpy:true", "starlette:false"]
    );
  });

  test("yarn: a member's package.json is read with the root lockfile", () => {
    const result = parseManifests([
      { path: "package.json", content: JSON.stringify({ workspaces: ["packages/*"] }) },
      { path: "yarn.lock", content: ['"clsx@npm:^2.1.0":', "  version: 2.1.1", "", '"ms@npm:^2.1.3":', "  version: 2.1.3"].join("\n") },
      { path: "packages/ui/package.json", content: JSON.stringify({ dependencies: { clsx: "^2.1.0" } }) },
    ]);
    assert.deepEqual(result.notes, [], "the member is covered by the root lockfile");
    assert.equal(find(result.dependencies, "clsx")!.direct, true);
    assert.equal(find(result.dependencies, "ms")!.direct, false);
  });

  test("a nested project with its own lockfile keeps its declarations to itself", () => {
    const lock = (name: string, version: string) => `[[package]]\nname = "${name}"\nversion = "${version}"\n${REGISTRY}\n`;
    const result = parseManifests([
      { path: "Cargo.toml", content: '[dependencies]\nserde = "1"\n' },
      { path: "Cargo.lock", content: [lock("serde", "1.0.203"), lock("rand", "0.7.3")].join("\n") },
      { path: "tools/gen/Cargo.toml", content: '[dependencies]\nrand = "0.8"\n' },
      { path: "tools/gen/Cargo.lock", content: lock("rand", "0.8.5") },
    ]);
    assert.deepEqual(result.manifests.sort(), ["Cargo.lock", "tools/gen/Cargo.lock"]);
    assert.equal(find(result.dependencies, "rand", "0.8.5")!.direct, true, "the tool asked for rand itself");
    assert.equal(
      find(result.dependencies, "rand", "0.7.3")!.direct,
      false,
      "the root did not: the tool's Cargo.toml answers to the tool's lockfile"
    );
  });

  test("bun: the lockfile covers its workspace members", () => {
    const result = parseManifests([
      { path: "package.json", content: JSON.stringify({ dependencies: { react: "^19" } }) },
      { path: "bun.lock", content: '{ "workspaces": { "": { "dependencies": { "react": "^19" } } }, "packages": { "react": ["react@19.0.0", "", {}, "sha512-x"] } }' },
      { path: "packages/ui/package.json", content: JSON.stringify({ dependencies: { clsx: "^2" } }) },
    ]);
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.manifests, ["bun.lock"]);
    assert.deepEqual(result.dependencies.map((d) => `${d.name}@${d.version}`), ["react@19.0.0"]);
  });
});

describe("dropRedundantRanges", () => {
  const d = (over: Partial<Dependency>): Dependency => ({
    ecosystem: "crates.io",
    name: "serde",
    version: "1.0.203",
    pinned: true,
    direct: false,
    scope: "unknown",
    ...over,
  });

  test("a range is dropped once the same package has an exact version", () => {
    const out = dropRedundantRanges([d({ version: "^1.0", pinned: false }), d({})]);
    assert.deepEqual(out.map((x) => x.version), ["1.0.203"]);
  });

  test("the range's one useful fact, that the repo asked for it, carries over", () => {
    const out = dropRedundantRanges([d({ version: "^1.0", pinned: false, direct: true }), d({}), d({ version: "1.0.100" })]);
    assert.deepEqual(out.map((x) => `${x.version}:${x.direct}`), ["1.0.203:true", "1.0.100:true"]);
  });

  test("a range with nothing resolved beside it is kept, so it can be reported", () => {
    const out = dropRedundantRanges([d({ name: "rand", version: "^0.8", pinned: false }), d({})]);
    assert.deepEqual(out.map((x) => x.name), ["rand", "serde"]);
  });

  test("the same name in another ecosystem is another package", () => {
    const out = dropRedundantRanges([d({ ecosystem: "npm", version: "^1.0", pinned: false }), d({})]);
    assert.equal(out.length, 2);
  });

  test("parseSpdx applies it to a graph built from a manifest and its lockfile", () => {
    const pkg = (id: string, purl: string) => ({ SPDXID: id, externalRefs: [{ referenceType: "purl", referenceLocator: purl }] });
    const deps = parseSpdx({
      packages: [
        pkg("root", "pkg:github/acme/app@main"),
        pkg("a", "pkg:cargo/serde@%5E1.0"),
        pkg("b", "pkg:cargo/serde@1.0.203"),
        pkg("c", "pkg:githubactions/actions/checkout@6.*.*"),
      ],
      relationships: [
        { spdxElementId: "SPDXRef-DOCUMENT", relatedSpdxElement: "root", relationshipType: "DESCRIBES" },
        { spdxElementId: "root", relatedSpdxElement: "a", relationshipType: "DEPENDS_ON" },
        { spdxElementId: "root", relatedSpdxElement: "c", relationshipType: "DEPENDS_ON" },
      ],
    });
    assert.deepEqual(deps.map((x) => `${x.name}@${x.version}:${x.direct}`), ["serde@1.0.203:true", "actions/checkout@6.*.*:true"]);
  });
});

describe("buildInventory", () => {
  const lockfiles = [
    { path: "package.json", content: JSON.stringify({ dependencies: { next: "^16" } }) },
    {
      path: "package-lock.json",
      content: JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/next": { version: "16.3.8" } } }),
    },
  ];
  const graphDep = (over: Partial<Dependency>): Dependency => ({
    ecosystem: "npm",
    name: "next",
    version: "16.3.8",
    pinned: true,
    direct: true,
    scope: "unknown",
    manifest: "dependency graph",
    ...over,
  });
  const graph = [
    graphDep({}),
    graphDep({ name: "fixture-only", version: "0.0.1" }),
    graphDep({ ecosystem: "Maven", name: "org.apache.logging.log4j:log4j-core", version: "2.14.1" }),
    graphDep({ ecosystem: "GitHub Actions", name: "actions/checkout", version: "6.*.*", pinned: false }),
  ];

  test("lockfiles alone", () => {
    const inventory = buildInventory(lockfiles, null);
    assert.equal(inventory.method, "lockfiles");
    assert.deepEqual(inventory.manifests, ["package-lock.json"]);
    assert.deepEqual(inventory.dependencies.map((d) => `${d.name}@${d.version}`), ["next@16.3.8"]);
    assert.deepEqual(inventory.notes, []);
  });

  test("the graph fills in ecosystems the lockfiles do not cover, and nothing else", () => {
    const inventory = buildInventory(lockfiles, graph);
    assert.equal(inventory.method, "both");
    assert.deepEqual(inventory.manifests, ["package-lock.json", "GitHub dependency graph"]);
    assert.deepEqual(inventory.dependencies.map((d) => d.name), ["next", "org.apache.logging.log4j:log4j-core", "actions/checkout"]);
    assert.equal(inventory.dependencies[0].manifest, "package-lock.json", "the lockfile's own entry, with its scope and manager");
    assert.equal(inventory.dependencies.find((d) => d.name === "fixture-only"), undefined, "npm was already answered by the lockfile");
  });

  test("with no readable manifests the graph is the whole answer", () => {
    const inventory = buildInventory([], graph);
    assert.equal(inventory.method, "sbom");
    assert.deepEqual(inventory.manifests, ["GitHub dependency graph"]);
    assert.equal(inventory.dependencies.length, 4);
    assert.deepEqual(inventory.notes, []);
  });

  test("a repo too large to read file by file uses the graph, if it has real versions", () => {
    const inventory = buildInventory(lockfiles, graph, { truncated: true });
    assert.equal(inventory.method, "sbom");
    assert.equal(inventory.dependencies.length, 4);
  });

  test("a truncated read still beats a graph that is mostly ranges", () => {
    const ranges = [graphDep({ version: "^16", pinned: false }), graphDep({ name: "react", version: "^19", pinned: false }), graphDep({ name: "ms", version: "2.1.3" })];
    const inventory = buildInventory(lockfiles, ranges, { truncated: true });
    assert.equal(inventory.method, "lockfiles");
    assert.deepEqual(inventory.dependencies.map((d) => `${d.name}@${d.version}`), ["next@16.3.8"]);
  });

  test("an empty repo, and one whose manifests cannot be read, each say why nothing was found", () => {
    assert.deepEqual(buildInventory([], null).notes, ["No dependency manifests were found in this repository."]);
    assert.deepEqual(buildInventory([{ path: "Cargo.toml", content: '[dependencies]\nserde = "1"' }], null).notes, [
      "Manifests were found, but none in a format Devlr can read yet.",
    ]);
    assert.deepEqual(buildInventory([], []).notes, ["No dependency manifests were found in this repository."]);
  });

  test("a package.json with no lockfile keeps its note, and is not replaced by the graph's copy of the same ranges", () => {
    const inventory = buildInventory([lockfiles[0]], [graphDep({ version: "^16", pinned: false })]);
    assert.equal(inventory.method, "lockfiles");
    assert.equal(inventory.dependencies.length, 1);
    assert.equal(inventory.dependencies[0].manifest, "package.json");
    assert.match(inventory.notes[0], /no lockfile/);
  });
});
