import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTitle,
  titleTokens,
  titleSimhash,
  hammingDistance,
  jaccard,
  sameStoryByTitle,
} from "@/lib/sources/simhash";

describe("normalizeTitle", () => {
  test("drops a trailing site name", () => {
    assert.equal(normalizeTitle("Postgres 18 Released | Hacker News"), "postgres 18 released");
    assert.equal(normalizeTitle("Postgres 18 Released - The Register"), "postgres 18 released");
  });

  test("keeps a real subtitle after a dash", () => {
    assert.match(normalizeTitle("Postgres 18 - async I/O arrives at last"), /async/);
  });

  test("keeps version numbers whole", () => {
    assert.deepEqual(titleTokens("Rust 1.90.0 is out"), ["rust", "1.90.0", "out"]);
  });

  test("keeps language names that contain symbols", () => {
    assert.ok(titleTokens("Modern C++ and C# compared").includes("c++"));
    assert.ok(titleTokens("Modern C++ and C# compared").includes("c#"));
  });
});

describe("titleSimhash", () => {
  test("is stable and fits a signed 64-bit integer", () => {
    const hash = titleSimhash("Postgres 18 ships asynchronous I/O")!;
    assert.equal(hash, titleSimhash("Postgres 18 ships asynchronous I/O"));
    const n = BigInt(hash);
    assert.ok(n >= -(2n ** 63n) && n < 2n ** 63n);
  });

  test("ignores case, punctuation and site suffixes", () => {
    assert.equal(
      titleSimhash("Postgres 18 Ships Asynchronous I/O"),
      titleSimhash("postgres 18 ships asynchronous i/o | Example News")
    );
  });

  test("returns null when nothing meaningful is left", () => {
    assert.equal(titleSimhash("The A An"), null);
    assert.equal(titleSimhash(""), null);
  });

  test("unrelated titles are far apart", () => {
    const a = titleSimhash("Postgres 18 ships asynchronous I/O and faster planner")!;
    const b = titleSimhash("Kubernetes drops support for an old container runtime")!;
    assert.ok(hammingDistance(a, b) > 12, `distance ${hammingDistance(a, b)}`);
  });
});

describe("hammingDistance", () => {
  test("counts differing bits, including across the sign bit", () => {
    assert.equal(hammingDistance("0", "0"), 0);
    assert.equal(hammingDistance("0", "1"), 1);
    assert.equal(hammingDistance("0", "-1"), 64);
    assert.equal(hammingDistance("5", "6"), 2);
  });
});

describe("jaccard", () => {
  test("is 1 for identical sets, 0 for disjoint or empty", () => {
    assert.equal(jaccard(["a", "b"], ["b", "a"]), 1);
    assert.equal(jaccard(["a"], ["b"]), 0);
    assert.equal(jaccard([], ["a"]), 0);
  });
});

describe("sameStoryByTitle", () => {
  test("the same headline from two outlets is one story", () => {
    assert.ok(
      sameStoryByTitle(
        "Cloudflare outage traced to a bad configuration push",
        "Cloudflare outage traced to bad configuration push - The Register"
      )
    );
  });

  test("a reworded headline with most words shared is one story", () => {
    assert.ok(
      sameStoryByTitle(
        "GitHub Actions adds native ARM runners for public repositories",
        "GitHub Actions now has native ARM runners for public repositories"
      )
    );
  });

  test("different versions of the same product are different stories", () => {
    assert.ok(!sameStoryByTitle("Go 1.26 released", "Go 1.25 released"));
    assert.ok(
      !sameStoryByTitle(
        "Node.js 24.1.0 fixes a memory leak in the HTTP parser",
        "Node.js 22.9.0 fixes a memory leak in the HTTP parser"
      )
    );
  });

  test("short titles must match exactly", () => {
    assert.ok(sameStoryByTitle("Rust 1.90", "Rust 1.90 | Rust Blog"));
    assert.ok(!sameStoryByTitle("Rust compiler internals", "Rust async internals"));
  });

  test("unrelated stories are not merged", () => {
    assert.ok(
      !sameStoryByTitle(
        "Postgres 18 ships asynchronous I/O",
        "Why we moved our monolith off Kubernetes"
      )
    );
  });

  test("empty titles never match", () => {
    assert.ok(!sameStoryByTitle("", ""));
  });
});
