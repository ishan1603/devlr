import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeItem,
  mergeByUrl,
  mergePopularity,
  popularityScore,
  inferKind,
} from "@/lib/content/normalize";
import { parseFeed } from "@/lib/sources/fetchers/rss";
import { tagText, sanitizeTags, userTags } from "@/lib/topics/catalog";
import { fallbackSummary } from "@/lib/content/summarize";
import type { RawItem, SourceDef } from "@/lib/sources/types";

function raw(overrides: Partial<RawItem> = {}): RawItem {
  return {
    url: "https://example.com/post",
    title: "Postgres 18 ships asynchronous I/O",
    description: "The new release adds async I/O.",
    sourceId: "rss:example",
    sourceName: "Example",
    category: "blog",
    quality: 0.8,
    tags: [],
    ...overrides,
  };
}

describe("normalizeItem", () => {
  test("canonicalises the URL and tags from the text", () => {
    const item = normalizeItem(raw({ url: "https://www.example.com/post/?utm_source=x" }))!;
    assert.equal(item.canonical_url, "https://example.com/post");
    assert.equal(item.site, "example.com");
    assert.ok(item.tags.includes("postgres"));
    // A stack match implies its domains.
    assert.ok(item.tags.includes("backend"));
  });

  test("rejects unusable links and junk titles", () => {
    assert.equal(normalizeItem(raw({ url: "javascript:alert(1)" })), null);
    assert.equal(normalizeItem(raw({ title: "Hi" })), null);
    assert.equal(normalizeItem(raw({ title: "[$] A subscriber-only article about kernels" })), null);
    assert.equal(normalizeItem(raw({ title: "Join our webinar on cloud cost optimisation" })), null);
    assert.equal(normalizeItem(raw({ title: "A Bootiful Podcast: an interview" })), null);
  });

  test("keeps source topics as seed tags", () => {
    const item = normalizeItem(raw({ title: "Something entirely generic happened", description: "", tags: ["rust"] }))!;
    assert.ok(item.tags.includes("rust"));
  });
});

describe("inferKind", () => {
  test("an official post with a version in the title is a release", () => {
    assert.equal(inferKind(raw({ category: "official", title: "Node.js 22.23.3 (LTS)" }), "nodejs.org"), "release");
    assert.equal(inferKind(raw({ category: "official", title: "Platform-independent SIMD in Go" }), "go.dev"), "blog");
  });

  test("aggregator links are classified by where they point", () => {
    assert.equal(inferKind(raw({ category: "aggregator" }), "theregister.com"), "news");
    assert.equal(inferKind(raw({ category: "aggregator" }), "github.com"), "repo");
    assert.equal(inferKind(raw({ category: "aggregator" }), "arxiv.org"), "paper");
    assert.equal(inferKind(raw({ category: "aggregator" }), "someone.dev"), "blog");
  });
});

describe("popularityScore", () => {
  test("is 0 with no signal and never exceeds 1", () => {
    assert.equal(popularityScore({}), 0);
    assert.equal(popularityScore(undefined), 0);
    assert.equal(popularityScore({ hn_points: 1_000_000 }), 1);
  });

  test("grows with votes, with diminishing returns", () => {
    const a = popularityScore({ hn_points: 50 });
    const b = popularityScore({ hn_points: 150 });
    const c = popularityScore({ hn_points: 250 });
    assert.ok(a < b && b < c);
    assert.ok(b - a > c - b, "the first hundred points should matter more than the next");
  });

  test("takes the strongest signal across communities", () => {
    assert.equal(
      popularityScore({ hn_points: 800, lobsters_score: 1 }),
      popularityScore({ hn_points: 800 })
    );
  });
});

describe("mergePopularity", () => {
  test("keeps the higher count per field and unions fields", () => {
    assert.deepEqual(
      mergePopularity({ hn_points: 100, hn_id: "1" }, { hn_points: 80, lobsters_score: 30 }),
      { hn_points: 100, hn_id: "1", lobsters_score: 30 }
    );
  });
});

describe("mergeByUrl", () => {
  test("a feed item and an aggregator item become one, attributed to the feed", () => {
    const feed = normalizeItem(raw({ sourceId: "rss:pg", sourceName: "PostgreSQL News", category: "official" }))!;
    const hn = normalizeItem(
      raw({
        url: "https://example.com/post?utm_source=hn",
        sourceId: "hn:top",
        sourceName: "Hacker News",
        category: "aggregator",
        quality: 0.6,
        description: undefined,
        popularity: { hn_points: 400, hn_id: "42" },
      })
    )!;

    for (const order of [[feed, hn], [hn, feed]]) {
      const merged = mergeByUrl(order);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source_id, "rss:pg");
      assert.equal(merged[0].popularity.hn_points, 400);
      assert.ok(merged[0].pop_score > 0);
      assert.equal(merged[0].description, "The new release adds async I/O.");
    }
  });

  test("different URLs are left alone", () => {
    const a = normalizeItem(raw({ url: "https://example.com/a" }))!;
    const b = normalizeItem(raw({ url: "https://example.com/b" }))!;
    assert.equal(mergeByUrl([a, b]).length, 2);
  });
});

describe("tagText", () => {
  test("does not confuse ordinary words with languages", () => {
    assert.ok(!tagText("Go to the settings page and react to the alert").includes("go"));
    assert.ok(!tagText("Go to the settings page and react to the alert").includes("react"));
    assert.ok(!tagText("Swift action on the outage").includes("swift"));
    assert.ok(!tagText("Better type inference in the compiler").includes("ai"));
  });

  test("finds them when they are meant", () => {
    assert.ok(tagText("Platform-independent SIMD in Go").includes("go"));
    assert.ok(tagText("Go 1.26 is released").includes("go"));
    assert.ok(tagText("React Compiler reaches 1.0").includes("react"));
    assert.ok(tagText("Why Rust's borrow checker rejects this").includes("rust"));
    assert.ok(tagText("Modern C++ and C# compared").includes("cpp"));
    assert.ok(tagText("Modern C++ and C# compared").includes("csharp"));
  });

  test("JavaScript does not also tag Java", () => {
    const tags = tagText("JavaScript engines got faster this year");
    assert.ok(tags.includes("javascript"));
    assert.ok(!tags.includes("java"));
  });
});

describe("sanitizeTags / userTags", () => {
  test("drop anything outside the vocabulary", () => {
    assert.deepEqual(sanitizeTags(["react", "nonsense", 5, null, "react"]), ["react"]);
    assert.deepEqual(sanitizeTags("react"), []);
    assert.deepEqual(userTags(["backend", "bogus"], ["postgres"]), ["backend", "postgres"]);
  });
});

describe("fallbackSummary", () => {
  test("takes whole sentences and stays short", () => {
    const text =
      "Postgres 18 is out. It adds asynchronous I/O, which speeds up sequential scans considerably on fast storage. " +
      "There are many other changes. ".repeat(20);
    const out = fallbackSummary(text);
    assert.ok(out.length <= 320, String(out.length));
    assert.ok(out.startsWith("Postgres 18 is out."));
    assert.ok(/[.!?]$/.test(out));
  });

  test("removes dashes and exclamation marks", () => {
    const out = fallbackSummary("PHP 8.4.26 Released! It is fast \u2014 very fast.");
    assert.ok(!out.includes("!"));
    assert.ok(!/[\u2013\u2014]/.test(out));
  });

  test("empty in, empty out", () => {
    assert.equal(fallbackSummary(""), "");
  });
});

describe("parseFeed", () => {
  const source: SourceDef = {
    id: "rss:test",
    kind: "rss",
    name: "Test",
    url: "https://example.com/feed.xml",
    category: "blog",
    topics: ["rust"],
    quality: 0.8,
  };
  const recent = new Date(Date.now() - 86_400_000).toUTCString();
  const recentIso = new Date(Date.now() - 86_400_000).toISOString();

  test("reads RSS 2.0, including CDATA, entities and relative links", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title><![CDATA[Rust 1.90 &amp; friends]]></title><link>/posts/rust-190</link>
        <description><![CDATA[<p>Faster <b>builds</b>.</p>]]></description>
        <pubDate>${recent}</pubDate><dc:creator xmlns:dc="x">Ferris</dc:creator></item>
    </channel></rss>`;
    const [item] = parseFeed(xml, source);
    assert.equal(item.title, "Rust 1.90 & friends");
    assert.equal(item.url, "https://example.com/posts/rust-190");
    assert.match(item.description!, /Faster\s+builds/);
    assert.ok(!item.description!.includes("<"));
    assert.equal(item.author, "Ferris");
    assert.deepEqual(item.tags, ["rust"]);
  });

  test("reads Atom and picks the alternate link, not the self link", () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title type="html">Version 1.90 released</title>
        <link rel="self" href="https://example.com/feed.xml"/>
        <link rel="alternate" href="https://example.com/a"/>
        <updated>${recentIso}</updated><summary>Short.</summary>
        <author><name>Ada</name></author></entry></feed>`;
    const [item] = parseFeed(xml, source);
    assert.equal(item.url, "https://example.com/a");
    assert.equal(item.title, "Version 1.90 released");
    assert.equal(item.author, "Ada");
  });

  test("a numeric-looking title stays a string", () => {
    const xml = `<rss><channel><item><title>1.90</title><link>https://example.com/v</link><pubDate>${recent}</pubDate></item></channel></rss>`;
    assert.equal(parseFeed(xml, source)[0].title, "1.90");
  });

  test("drops old items and items without a link or title", () => {
    const xml = `<rss><channel>
      <item><title>Ancient history</title><link>https://example.com/old</link><pubDate>Mon, 01 Jan 2018 00:00:00 GMT</pubDate></item>
      <item><title>No link here</title></item>
      <item><link>https://example.com/untitled</link></item>
    </channel></rss>`;
    assert.deepEqual(parseFeed(xml, source), []);
  });

  test("a future date is pulled back to now", () => {
    const xml = `<rss><channel><item><title>Conference next year</title><link>https://example.com/c</link><pubDate>Mon, 11 Oct 2038 00:00:00 GMT</pubDate></item></channel></rss>`;
    const [item] = parseFeed(xml, source);
    assert.ok(Date.parse(item.publishedAt!) <= Date.now());
  });
});
