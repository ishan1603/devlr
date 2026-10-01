import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  relevance,
  recency,
  scoreCandidate,
  selectDiverse,
  buildAffinity,
  affinityFor,
  overlap,
  type Candidate,
  type RankContext,
} from "@/lib/content/rank";

const NOW = new Date("2026-10-01T12:00:00Z");

function ctx(overrides: Partial<RankContext> = {}): RankContext {
  return {
    stack: ["postgres", "typescript"],
    domains: ["backend"],
    affinity: new Map(),
    now: NOW,
    windowDays: 7,
    ...overrides,
  };
}

let seq = 0;
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  seq++;
  return {
    id: `item-${seq}`,
    clusterId: `cluster-${seq}`,
    canonicalUrl: `https://site${seq}.example/post-${seq}`,
    url: `https://site${seq}.example/post-${seq}`,
    title: `Unique headline number ${seq} about subject ${seq * 7919}`,
    summary: "A summary.",
    sourceId: `rss:source-${seq}`,
    sourceName: `Source ${seq}`,
    site: `site${seq}.example`,
    kind: "blog",
    tags: ["backend"],
    popularity: {},
    popScore: 0.3,
    quality: 3,
    sourceQuality: 0.7,
    readingMinutes: 5,
    publishedAt: "2026-10-01T00:00:00Z",
    similarity: null,
    ...overrides,
  };
}

describe("relevance", () => {
  test("a stack match outranks a domain match, which outranks nothing", () => {
    const stack = relevance(candidate({ tags: ["postgres"] }), ctx());
    const domain = relevance(candidate({ tags: ["backend"] }), ctx());
    const none = relevance(candidate({ tags: ["gamedev"] }), ctx());
    assert.ok(stack > domain, `${stack} > ${domain}`);
    assert.ok(domain > none);
    assert.equal(none, 0);
  });

  test("more stack hits score at least as high, and never above 1", () => {
    const one = relevance(candidate({ tags: ["postgres"] }), ctx());
    const two = relevance(candidate({ tags: ["postgres", "typescript"] }), ctx());
    assert.ok(two >= one);
    assert.ok(two <= 1);
  });

  test("a close vector rescues an article the tagger missed", () => {
    const untagged = candidate({ tags: [], similarity: 0.82 });
    assert.ok(relevance(untagged, ctx()) > 0.5);
  });

  test("a distant vector contributes nothing on its own", () => {
    assert.equal(relevance(candidate({ tags: [], similarity: 0.4 }), ctx()), 0);
  });

  test("a vector alone never beats a direct stack match", () => {
    const vectorOnly = relevance(candidate({ tags: [], similarity: 0.99 }), ctx());
    const stackMatch = relevance(candidate({ tags: ["postgres"], similarity: 0.6 }), ctx());
    assert.ok(stackMatch > vectorOnly, `${stackMatch} > ${vectorOnly}`);
  });

  test("always lands in [0, 1]", () => {
    for (const similarity of [null, -1, 0, 0.5, 0.7, 1, 2]) {
      for (const tags of [[], ["backend"], ["postgres", "typescript", "backend"]]) {
        const r = relevance(candidate({ tags, similarity }), ctx());
        assert.ok(r >= 0 && r <= 1, `similarity=${similarity} tags=${tags} gave ${r}`);
      }
    }
  });
});

describe("recency", () => {
  test("halves after half the window", () => {
    const fresh = recency("2026-10-01T12:00:00Z", ctx());
    const half = recency("2026-09-28T00:00:00Z", ctx()); // 3.5 days earlier
    assert.equal(fresh, 1);
    assert.ok(Math.abs(half - 0.5) < 1e-9, String(half));
  });

  test("a future date is treated as now, not as extra fresh", () => {
    assert.equal(recency("2027-01-01T00:00:00Z", ctx()), 1);
  });

  test("a daily issue ages articles faster than a monthly one", () => {
    const published = "2026-09-29T12:00:00Z";
    assert.ok(recency(published, ctx({ windowDays: 2 })) < recency(published, ctx({ windowDays: 30 })));
  });
});

describe("scoreCandidate", () => {
  test("all else equal, more popular scores higher", () => {
    const quiet = scoreCandidate(candidate({ popScore: 0.1 }), ctx());
    const loud = scoreCandidate(candidate({ popScore: 0.9 }), ctx());
    assert.ok(loud.score > quiet.score);
  });

  test("relevance outweighs popularity", () => {
    const relevantQuiet = scoreCandidate(candidate({ tags: ["postgres"], popScore: 0.1 }), ctx());
    const offTopicViral = scoreCandidate(candidate({ tags: ["gamedev"], popScore: 1 }), ctx());
    assert.ok(relevantQuiet.score > offTopicViral.score);
  });

  test("negative feedback lowers a score and positive feedback raises it", () => {
    const item = candidate({ tags: ["postgres"] });
    const neutral = scoreCandidate(item, ctx()).score;
    const liked = scoreCandidate(item, ctx({ affinity: new Map([["tag:postgres", 0.8]]) })).score;
    const disliked = scoreCandidate(item, ctx({ affinity: new Map([["tag:postgres", -0.8]]) })).score;
    assert.ok(liked > neutral && neutral > disliked);
  });

  test("feedback cannot make an irrelevant article relevant", () => {
    const offTopic = candidate({ tags: ["gamedev"] });
    const boosted = scoreCandidate(offTopic, ctx({ affinity: new Map([["tag:gamedev", 1]]) }));
    assert.equal(boosted.relevance, 0);
  });
});

describe("selectDiverse", () => {
  const score = (c: Candidate) => scoreCandidate(c, ctx());

  test("returns at most the requested count, best first", () => {
    const pool = [0.1, 0.9, 0.5, 0.7].map((popScore) => score(candidate({ popScore })));
    const picked = selectDiverse(pool, { count: 3, lambda: 1 });
    assert.equal(picked.length, 3);
    assert.deepEqual(
      picked.map((p) => p.popScore),
      [0.9, 0.7, 0.5]
    );
  });

  test("never picks two articles from the same story", () => {
    const pool = [
      score(candidate({ clusterId: "same", popScore: 0.9 })),
      score(candidate({ clusterId: "same", popScore: 0.8 })),
      score(candidate({ clusterId: "other", popScore: 0.2 })),
    ];
    const picked = selectDiverse(pool, { count: 3 });
    assert.equal(picked.length, 2);
    assert.equal(new Set(picked.map((p) => p.clusterId)).size, 2);
    // And from the shared cluster it kept the better one.
    assert.equal(picked.find((p) => p.clusterId === "same")!.popScore, 0.9);
  });

  test("caps how many come from one site", () => {
    const pool = Array.from({ length: 5 }, () => score(candidate({ site: "one.example" })));
    assert.equal(selectDiverse(pool, { count: 5, maxPerSite: 2 }).length, 2);
  });

  test("drops articles below the relevance floor", () => {
    const pool = [score(candidate({ tags: ["gamedev"], popScore: 1 })), score(candidate({ tags: ["postgres"] }))];
    const picked = selectDiverse(pool, { count: 5 });
    assert.equal(picked.length, 1);
    assert.deepEqual(picked[0].tags, ["postgres"]);
  });

  test("prefers a different topic over a near-repeat of the top pick", () => {
    const top = score(candidate({ title: "Postgres 18 ships asynchronous I/O", tags: ["postgres", "backend"], popScore: 0.9 }));
    const repeat = score(candidate({ title: "Postgres 18 asynchronous I/O explained", tags: ["postgres", "backend"], popScore: 0.8 }));
    const different = score(candidate({ title: "TypeScript 6 changes module resolution defaults", tags: ["typescript"], popScore: 0.5 }));

    const picked = selectDiverse([top, repeat, different], { count: 2, lambda: 0.6 });
    assert.equal(picked[0].id, top.id);
    assert.equal(picked[1].id, different.id);
  });

  test("handles an empty pool", () => {
    assert.deepEqual(selectDiverse([], { count: 5 }), []);
  });
});

describe("overlap", () => {
  test("same cluster is total overlap", () => {
    assert.equal(overlap(candidate({ clusterId: "x" }), candidate({ clusterId: "x" })), 1);
  });

  test("unrelated articles barely overlap", () => {
    const a = candidate({ title: "Postgres planner internals", tags: ["postgres"] });
    const b = candidate({ title: "Shipping a game on Godot", tags: ["gamedev"] });
    assert.ok(overlap(a, b) < 0.1);
  });
});

describe("buildAffinity", () => {
  const row = (overrides: object) => ({
    signal: 1,
    tags: ["react"],
    site: "example.com",
    source_id: "rss:example",
    created_at: NOW.toISOString(),
    ...overrides,
  });

  test("a like and a dislike of the same thing cancel", () => {
    const affinity = buildAffinity([row({ signal: 1 }), row({ signal: -1 })], NOW);
    assert.ok(Math.abs(affinity.get("tag:react") ?? 0) < 1e-9);
  });

  test("a vote is split across the tags it carried", () => {
    const one = buildAffinity([row({ tags: ["react"] })], NOW).get("tag:react")!;
    const five = buildAffinity([row({ tags: ["react", "a", "b", "c", "d"] })], NOW).get("tag:react")!;
    assert.ok(Math.abs(one - 5 * five) < 1e-9);
  });

  test("old votes count for less", () => {
    const recent = buildAffinity([row({})], NOW).get("tag:react")!;
    const old = buildAffinity([row({ created_at: "2026-07-03T12:00:00Z" })], NOW).get("tag:react")!;
    assert.ok(Math.abs(old - recent / 2) < 1e-6, `${old} vs ${recent}`);
  });

  test("the total for one article is clamped to [-1, 1]", () => {
    const many = Array.from({ length: 50 }, () => row({ signal: -1 }));
    const affinity = buildAffinity(many, NOW);
    const value = affinityFor(candidate({ tags: ["react"], site: "example.com", sourceId: "rss:example" }), affinity);
    assert.equal(value, -1);
  });
});
