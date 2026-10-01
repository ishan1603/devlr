import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  cleanProse,
  replaceDashes,
  lintProse,
  lintSubject,
  fitSubject,
  describeIssues,
  SUBJECT_MAX_LENGTH,
} from "@/lib/ai/style";

const rules = (issues: { rule: string }[]) => issues.map((i) => i.rule);

describe("replaceDashes", () => {
  test("an em dash between clauses becomes a comma", () => {
    assert.equal(
      replaceDashes("Postgres 18 is out \u2014 and async I/O is the headline."),
      "Postgres 18 is out, and async I/O is the headline."
    );
  });

  test("an unspaced em dash is handled the same way", () => {
    assert.equal(replaceDashes("fast\u2014really fast"), "fast, really fast");
  });

  test("a numeric range keeps its meaning as a hyphen", () => {
    assert.equal(replaceDashes("supported 2019\u20132021"), "supported 2019-2021");
    assert.equal(replaceDashes("takes 10 \u2013 20ms"), "takes 10-20ms");
  });

  test("an en dash between words becomes a comma", () => {
    assert.equal(replaceDashes("the fix \u2013 a one line change"), "the fix, a one line change");
  });

  test("a spaced hyphen used as a dash is rewritten, a real hyphen is not", () => {
    assert.equal(replaceDashes("the fix - a one line change"), "the fix, a one line change");
    assert.equal(replaceDashes("a use-after-free in the parser"), "a use-after-free in the parser");
  });

  test("a leading dash is a list marker and stays one", () => {
    assert.equal(replaceDashes("\u2014 first\n\u2014 second"), "- first\n- second");
  });

  test("a dash never joins two lines into one", () => {
    const input = "First point\n- second point";
    assert.equal(replaceDashes(input), input);
  });

  test("a dash before closing punctuation does not leave a stray comma", () => {
    assert.equal(replaceDashes("It shipped \u2014."), "It shipped.");
    assert.equal(replaceDashes("It shipped \u2014"), "It shipped");
  });

  test("no dash of either kind survives", () => {
    const out = replaceDashes("a \u2014 b \u2013 c\u2014d 1\u20132");
    assert.ok(!/[\u2013\u2014]/.test(out), out);
  });
});

describe("cleanProse", () => {
  test("normalises quotes, ellipses and whitespace", () => {
    assert.equal(cleanProse("  \u201cIt\u2019s  fine\u201d\u2026  "), "\"It's fine\"...");
  });

  test("output of cleanProse never trips the dash rule", () => {
    const cleaned = cleanProse("Rust 1.90 \u2014 faster builds \u2013 smaller binaries");
    assert.ok(!rules(lintProse(cleaned)).includes("dash"));
  });
});

describe("lintProse", () => {
  test("ordinary developer prose is clean", () => {
    assert.deepEqual(
      lintProse("Node 20 reaches end of life on April 30. Three of your repos still pin it."),
      []
    );
  });

  test("flags a surviving dash", () => {
    assert.ok(rules(lintProse("fast \u2014 really fast")).includes("dash"));
  });

  test("flags the same dash on consecutive calls", () => {
    // Guards against a global regex carrying lastIndex between calls.
    for (let i = 0; i < 3; i++) {
      assert.ok(rules(lintProse("fast \u2014 really fast")).includes("dash"), `call ${i}`);
    }
  });

  test("flags banned phrases regardless of case or apostrophe style", () => {
    assert.ok(rules(lintProse("Let's Delve into the details.")).includes("banned-phrase"));
    assert.ok(rules(lintProse("It\u2019s worth noting the change.")).includes("banned-phrase"));
  });

  test("does not flag a banned word hiding inside another word", () => {
    assert.deepEqual(lintProse("The seamlessness of it is not the point."), []);
  });

  test("flags exclamation marks and emoji", () => {
    assert.ok(rules(lintProse("It shipped!")).includes("exclamation"));
    assert.ok(rules(lintProse("It shipped \u{1F680}")).includes("emoji"));
  });

  test("flags shouting but leaves acronyms and identifiers alone", () => {
    assert.ok(rules(lintProse("This is AMAZING news")).includes("shouting"));
    assert.deepEqual(lintProse("CVE-2026-1234 is an RCE in the HTTP2 parser, tracked by CISA."), []);
    assert.deepEqual(lintProse("The JSON API returns a UUID over HTTPS."), []);
  });

  test("flags HTML and Markdown but not code that looks like a tag", () => {
    assert.ok(rules(lintProse("This is <strong>big</strong>")).includes("markup"));
    assert.ok(rules(lintProse("This is **big**")).includes("markup"));
    assert.deepEqual(lintProse("Array<string> now infers correctly inside a <script> block."), []);
  });

  test("empty text is its own issue", () => {
    assert.deepEqual(rules(lintProse("   ")), ["empty"]);
  });
});

describe("lintSubject", () => {
  test("a specific, plain subject passes", () => {
    assert.deepEqual(lintSubject("lodash in 3 of your repos has a fix waiting"), []);
    assert.deepEqual(lintSubject("Postgres 18 ships async I/O"), []);
  });

  test("enforces the length limit", () => {
    const long = "a".repeat(SUBJECT_MAX_LENGTH + 1);
    assert.ok(rules(lintSubject(long)).includes("too-long"));
  });

  test("flags spam triggers", () => {
    assert.ok(rules(lintSubject("Free upgrade for your stack")).includes("spam-trigger"));
    assert.ok(rules(lintSubject("Act now on this vulnerability")).includes("spam-trigger"));
  });

  test("'free' inside a hyphenated technical term is not a trigger", () => {
    assert.deepEqual(lintSubject("A use-after-free in libxml2 affects 2 repos"), []);
    assert.deepEqual(lintSubject("Lock-free queues, measured"), []);
  });
});

describe("fitSubject", () => {
  test("short subjects pass through cleaned", () => {
    assert.equal(fitSubject("Rust 1.90 \u2014 faster builds!"), "Rust 1.90, faster builds");
  });

  test("long subjects are cut on a word boundary with no ellipsis", () => {
    const out = fitSubject(
      "Postgres 18 ships asynchronous I/O and a long list of other planner improvements too"
    );
    assert.ok(out.length <= SUBJECT_MAX_LENGTH, `${out.length}: ${out}`);
    assert.ok(!out.endsWith("..."));
    assert.ok(!out.endsWith(" "));
    assert.ok("Postgres 18 ships asynchronous I/O and a long list of other planner improvements too".startsWith(out));
  });

  test("whatever goes in, the result passes the length rule", () => {
    for (const s of ["x".repeat(200), "word ".repeat(40), "a, b, c, ".repeat(20)]) {
      assert.ok(fitSubject(s).length <= SUBJECT_MAX_LENGTH);
    }
  });
});

describe("describeIssues", () => {
  test("produces one instruction per distinct problem", () => {
    const text = describeIssues(lintSubject("AMAZING \u2014 free stuff!"));
    assert.match(text, /em dash/);
    assert.match(text, /exclamation/);
    assert.match(text, /"free"/);
    assert.match(text, /AMAZING/);
  });
});
