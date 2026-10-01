import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeUrl, siteOf, safeHttpUrl } from "@/lib/sources/canonical";

describe("canonicalizeUrl", () => {
  test("tracking parameters, fragments and www do not change identity", () => {
    const expected = "https://example.com/post";
    for (const variant of [
      "https://example.com/post",
      "http://example.com/post",
      "https://www.example.com/post/",
      "https://example.com/post?utm_source=hn&utm_medium=social",
      "https://example.com/post#comments",
      "https://m.example.com/post?fbclid=abc&ref=homepage",
      "  https://EXAMPLE.com/post  ",
    ]) {
      assert.equal(canonicalizeUrl(variant), expected, variant);
    }
  });

  test("meaningful query parameters are kept, in a stable order", () => {
    assert.equal(
      canonicalizeUrl("https://example.com/search?q=rust&page=2"),
      canonicalizeUrl("https://example.com/search?page=2&q=rust&utm_campaign=x")
    );
    assert.equal(
      canonicalizeUrl("https://news.ycombinator.com/item?id=123"),
      "https://news.ycombinator.com/item?id=123"
    );
  });

  test("two different articles stay different", () => {
    assert.notEqual(
      canonicalizeUrl("https://example.com/post-one"),
      canonicalizeUrl("https://example.com/post-two")
    );
    assert.notEqual(
      canonicalizeUrl("https://example.com/item?id=1"),
      canonicalizeUrl("https://example.com/item?id=2")
    );
    // Path case can be significant, so it is left alone outside known hosts.
    assert.notEqual(canonicalizeUrl("https://example.com/Post"), canonicalizeUrl("https://example.com/post"));
  });

  test("AMP variants collapse to the article", () => {
    assert.equal(canonicalizeUrl("https://example.com/story/amp"), "https://example.com/story");
    assert.equal(canonicalizeUrl("https://amp.example.com/story/amp/"), "https://example.com/story");
  });

  test("arXiv abs, pdf and versioned links are one paper", () => {
    const expected = "https://arxiv.org/abs/2501.12345";
    assert.equal(canonicalizeUrl("https://arxiv.org/abs/2501.12345v2"), expected);
    assert.equal(canonicalizeUrl("https://arxiv.org/pdf/2501.12345"), expected);
    assert.equal(canonicalizeUrl("https://arxiv.org/pdf/2501.12345v3.pdf"), expected);
  });

  test("GitHub owner and repo are case-insensitive", () => {
    assert.equal(
      canonicalizeUrl("https://github.com/Vercel/Next.js/releases/tag/v16.0.0"),
      canonicalizeUrl("https://github.com/vercel/next.js/releases/tag/v16.0.0")
    );
  });

  test("the root path keeps its slash", () => {
    assert.equal(canonicalizeUrl("https://example.com"), "https://example.com/");
  });

  test("rejects anything that is not http(s)", () => {
    assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
    assert.equal(canonicalizeUrl("mailto:a@b.co"), null);
    assert.equal(canonicalizeUrl("not a url"), null);
    assert.equal(canonicalizeUrl(""), null);
  });

  test("is idempotent", () => {
    const once = canonicalizeUrl("http://www.Example.com/a//b/?utm_source=x&b=2&a=1#frag")!;
    assert.equal(canonicalizeUrl(once), once);
  });
});

describe("siteOf", () => {
  test("returns the host without presentation subdomains", () => {
    assert.equal(siteOf("https://www.theregister.com/2026/01/01/story"), "theregister.com");
    assert.equal(siteOf("https://blog.cloudflare.com/post"), "blog.cloudflare.com");
    assert.equal(siteOf("nope"), "");
  });
});

describe("safeHttpUrl", () => {
  test("passes http(s) and blanks everything else", () => {
    assert.equal(safeHttpUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(safeHttpUrl("javascript:alert(1)"), "");
    assert.equal(safeHttpUrl("data:text/html,<script>"), "");
    assert.equal(safeHttpUrl(null), "");
  });
});
