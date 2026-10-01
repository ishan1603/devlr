import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { inventedNumbers, isGrounded, reviewDraft, templateCopy } from "@/lib/delivery/editor";
import { lintProse, lintSubject, stripEmoji, cleanProse } from "@/lib/ai/style";
import { leadFirst } from "@/lib/modules/digest";
import { isMostlyLatin, weekOf, formatStars } from "@/lib/modules/pulse";
import { milestoneFor, daysUntil } from "@/lib/modules/eol";
import { cleanUrl } from "@/lib/sources/canonical";
import { renderIssueText } from "@/lib/email/render";
import { signFeedback, verifyFeedback } from "@/lib/delivery/tokens";
import type { Section, StoryItem } from "@/lib/delivery/issue";
import type { Scored } from "@/lib/content/rank";

function story(overrides: Partial<StoryItem> = {}): StoryItem {
  return {
    ref: "cluster-1",
    canonicalUrl: "https://example.com/pg18",
    url: "https://example.com/pg18",
    title: "Postgres 18 ships asynchronous I/O",
    summary: "Postgres 18 adds asynchronous I/O. Sequential scans on fast storage get up to 3 times faster.",
    source: "PostgreSQL News",
    site: "postgresql.org",
    kind: "release",
    tags: ["postgres"],
    meta: ["412 points on HN", "6 min read"],
    alsoCoveredBy: [],
    ...overrides,
  };
}

const SECTIONS: Section[] = [
  { type: "stories", module: "digest", label: "top story", title: "Top story", items: [story()] },
  {
    type: "stories",
    module: "digest",
    label: "news",
    title: "News",
    items: [story({ ref: "cluster-2", title: "Node.js 22.23.3 fixes an HTTP parser leak", summary: "A memory leak in the HTTP parser is fixed.", meta: [] })],
  },
  {
    type: "eol",
    module: "eol_watch",
    label: "eol watch",
    title: "Reaching end of life",
    entries: [{ ref: "nextjs:15:30", product: "Next.js", cycle: "15", eolDate: "2026-10-21", daysLeft: 20, latest: "16" }],
  },
];

describe("inventedNumbers", () => {
  test("numbers taken from the issue are allowed", () => {
    assert.deepEqual(inventedNumbers("Postgres 18 ships async I/O, up to 3 times faster", SECTIONS), []);
    assert.deepEqual(inventedNumbers("Node.js 22.23.3 is out", SECTIONS), []);
    assert.deepEqual(inventedNumbers("Next.js 15 ends Oct 21, 20 days from now", SECTIONS), []);
  });

  test("a version the issue never mentioned is caught", () => {
    assert.deepEqual(inventedNumbers("TypeScript Compiler API v5.4 adds narrowing", SECTIONS), ["5.4"]);
    assert.deepEqual(inventedNumbers("Postgres 19 ships async I/O", SECTIONS), ["19"]);
  });

  test("a shortened form of a real version is allowed", () => {
    assert.deepEqual(inventedNumbers("Node.js 22.23 and Node 22", SECTIONS), []);
  });

  test("counting the items in the issue is allowed", () => {
    // Three items in total, two in the stories sections.
    assert.deepEqual(inventedNumbers("3 things worth your time", SECTIONS), []);
  });
});

describe("isGrounded", () => {
  test("a subject built from the lead story is grounded", () => {
    assert.ok(isGrounded("Postgres 18 ships asynchronous I/O", SECTIONS));
  });

  test("a subject about something else is not", () => {
    assert.ok(!isGrounded("Kubernetes drops Docker support entirely", SECTIONS));
    assert.ok(!isGrounded("", SECTIONS));
  });
});

describe("reviewDraft", () => {
  const good = {
    subject: "Postgres 18 ships asynchronous I/O",
    preheader: "Also: Node.js 22.23.3 fixes a parser leak, and Next.js 15 nears end of life.",
    intro: "Postgres 18 is the one to read first. Async I/O changes how scans behave on fast disks.",
  };

  test("clean copy passes untouched", () => {
    const { issues, clean } = reviewDraft(good, SECTIONS);
    assert.deepEqual(issues, []);
    assert.equal(clean.subject, good.subject);
  });

  test("dashes are repaired silently rather than rejected", () => {
    const { issues, clean } = reviewDraft({ ...good, intro: "Postgres 18 is out \u2014 read it first." }, SECTIONS);
    assert.deepEqual(issues, []);
    assert.equal(clean.intro, "Postgres 18 is out, read it first.");
  });

  test("an invented version is rejected with a usable note", () => {
    const { issues, notes } = reviewDraft({ ...good, subject: "Postgres 18.4 ships asynchronous I/O" }, SECTIONS);
    assert.ok(issues.length > 0);
    assert.match(notes, /18\.4/);
  });

  test("a generic subject is rejected", () => {
    assert.ok(reviewDraft({ ...good, subject: "Your weekly Postgres 18 digest" }, SECTIONS).issues.length > 0);
  });

  test("an overlong preheader is rejected", () => {
    assert.ok(reviewDraft({ ...good, preheader: "Postgres ".repeat(20) }, SECTIONS).issues.length > 0);
  });

  test("hype in the intro is rejected", () => {
    const { issues } = reviewDraft({ ...good, intro: "Postgres 18 is a game-changer for databases." }, SECTIONS);
    assert.ok(issues.some((i) => i.rule === "banned-phrase"));
  });
});

describe("templateCopy", () => {
  const input = { sections: SECTIONS, interests: ["PostgreSQL", "Backend"], previousIntros: [], date: new Date("2026-10-01") };

  test("builds specific copy from the lead story, and it passes review", () => {
    const copy = templateCopy(input);
    assert.equal(copy.aiEdited, false);
    assert.equal(copy.subject, "Postgres 18 ships asynchronous I/O");
    assert.deepEqual(lintSubject(copy.subject), []);
    assert.deepEqual(lintProse(copy.intro), []);
    assert.ok(copy.preheader.length <= 110);
  });

  test("an issue with only an EOL section still gets a real subject", () => {
    const copy = templateCopy({ ...input, sections: [SECTIONS[2]] });
    assert.match(copy.subject, /Next\.js 15 reaches end of life in 20 days/);
  });
});

describe("style additions", () => {
  test("a trailing participle clause is flagged", () => {
    assert.ok(lintProse("The API now preserves narrowing, enabling more accurate checks.").some((i) => i.rule === "participle"));
    assert.ok(lintProse("The model reached delivery in 29% of runs, highlighting the risk.").some((i) => i.rule === "participle"));
  });

  test("the same verbs used normally are fine", () => {
    assert.deepEqual(lintProse("The release is about enabling async I/O by default."), []);
    assert.deepEqual(lintProse("Making the cache smaller reduced memory use by half."), []);
  });

  test("stripEmoji removes emoji and tidies spacing", () => {
    assert.equal(stripEmoji("Preserving narrowing in type guards \u{1F527}"), "Preserving narrowing in type guards");
    assert.equal(stripEmoji("\u{1F680} Launch day \u2764\ufe0f for devs"), "Launch day for devs");
  });

  test("cleanProse normalises non-breaking hyphens", () => {
    assert.equal(cleanProse("a 4.57% wall\u2011time reduction"), "a 4.57% wall-time reduction");
  });
});

describe("leadFirst", () => {
  const scored = (id: string, score: number, popScore: number, sourceQuality = 0.6): Scored =>
    ({ id, score, popScore, sourceQuality, quality: 3 }) as Scored;

  test("a widely read story leads over a slightly more relevant obscure one", () => {
    const out = leadFirst([scored("obscure", 0.62, 0), scored("big", 0.58, 0.8)]);
    assert.equal(out[0].id, "big");
    assert.equal(out.length, 2);
  });

  test("keeps the rest in their original order", () => {
    const out = leadFirst([scored("a", 0.6, 0), scored("b", 0.5, 0), scored("c", 0.55, 0.9)]);
    assert.deepEqual(out.map((o) => o.id), ["c", "a", "b"]);
  });

  test("leaves short lists alone", () => {
    assert.deepEqual(leadFirst([]), []);
  });
});

describe("pulse helpers", () => {
  test("isMostlyLatin", () => {
    assert.ok(isMostlyLatin("A personal agent with a browser, terminal and files."));
    assert.ok(!isMostlyLatin("\u4e00\u4e2a\u81ea\u5df1\u627e\u70ed\u70b9\u3001\u81ea\u5df1\u5199\u65e5\u62a5\u7684\u7f51\u7ad9\u6846\u67b6"));
    assert.ok(!isMostlyLatin("12345 !!!"));
  });

  test("weekOf returns the Monday of that week", () => {
    assert.equal(weekOf(new Date("2026-10-01T12:00:00Z")), "2026-09-28"); // a Thursday
    assert.equal(weekOf(new Date("2026-09-28T00:00:00Z")), "2026-09-28"); // a Monday
    assert.equal(weekOf(new Date("2026-10-04T23:59:00Z")), "2026-09-28"); // a Sunday
  });

  test("formatStars", () => {
    assert.equal(formatStars(412), "412");
    assert.equal(formatStars(7271), "7.3k");
    assert.equal(formatStars(24100), "24k");
  });
});

describe("EOL milestones", () => {
  test("each range maps to the milestone it has passed", () => {
    assert.equal(milestoneFor(120), null);
    assert.equal(milestoneFor(90), 90);
    assert.equal(milestoneFor(45), 90);
    assert.equal(milestoneFor(30), 30);
    assert.equal(milestoneFor(8), 30);
    assert.equal(milestoneFor(7), 7);
    assert.equal(milestoneFor(1), 7);
    assert.equal(milestoneFor(0), 0);
    assert.equal(milestoneFor(-10), 0);
    assert.equal(milestoneFor(-15), null);
  });

  test("daysUntil counts calendar days regardless of the time of day", () => {
    assert.equal(daysUntil("2026-10-21", new Date("2026-10-01T23:59:00Z")), 20);
    assert.equal(daysUntil("2026-10-01", new Date("2026-10-01T00:00:01Z")), 0);
    assert.equal(daysUntil("2026-09-30", new Date("2026-10-01T12:00:00Z")), -1);
  });
});

describe("cleanUrl", () => {
  test("drops tracking but keeps the host as published", () => {
    assert.equal(
      cleanUrl("https://www.socket.dev/blog/post?utm_medium=feed&id=7#top"),
      "https://www.socket.dev/blog/post?id=7#top"
    );
    assert.equal(cleanUrl("javascript:alert(1)"), "");
  });
});

describe("feedback tokens", () => {
  process.env.APP_SECRET = "test-secret";
  const claim = { userId: "0b0e5c5e-0000-4000-8000-000000000001", ref: "7c9e6679-7425-40de-944b-e07fc1f90ae7", signal: -1 as const };

  test("round-trips", () => {
    assert.deepEqual(verifyFeedback(signFeedback(claim)), claim);
  });

  test("a tampered token is rejected", () => {
    const token = signFeedback(claim);
    // Flip the direction: the signature no longer matches.
    assert.equal(verifyFeedback(token.replace(".l.", ".m.")), null);
    // Swap the user.
    assert.equal(verifyFeedback(token.replace("000000000001", "000000000002")), null);
    assert.equal(verifyFeedback("garbage"), null);
    assert.equal(verifyFeedback(""), null);
  });
});

describe("renderIssueText", () => {
  test("renders every section and the footer links", () => {
    const text = renderIssueText({
      issue: { subject: "s", preheader: "p", intro: "An intro.", date: "2026-10-01T08:00:00Z", sections: SECTIONS, aiEdited: false },
      links: { web: "https://d/issue/x", preferences: "https://d/app/settings", unsubscribe: "https://d/u" },
    });
    assert.match(text, /^DEVLR {2}2026-10-01/);
    assert.match(text, /\/\/ top story/);
    assert.match(text, /Postgres 18 ships asynchronous I\/O/);
    assert.match(text, /Next\.js 15: end of life 2026-10-21 \(20 days left\), current is 16/);
    assert.match(text, /Unsubscribe: https:\/\/d\/u/);
    assert.ok(!/[\u2013\u2014]/.test(text));
  });
});
