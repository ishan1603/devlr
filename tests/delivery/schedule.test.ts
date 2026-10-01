import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  coverageDays,
  daysBetween,
  evaluateDue,
  frequencyDays,
  localParts,
  type ScheduleProfile,
  type ScheduleSubscription,
} from "@/lib/delivery/schedule";
import { buildDedupeKey, manualSlot } from "@/lib/delivery/ledger";

function profile(overrides: Partial<ScheduleProfile> = {}): ScheduleProfile {
  return {
    user_id: "user-1",
    timezone: "UTC",
    send_time: "08:00",
    is_paused: false,
    onboarded_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function sub(overrides: Partial<ScheduleSubscription> = {}): ScheduleSubscription {
  return {
    module: "digest",
    is_active: true,
    frequency: "daily",
    custom_interval_days: null,
    last_sent_at: null,
    ...overrides,
  };
}

// 2026-10-01 is a Thursday.
const THU_0900 = new Date("2026-10-01T09:00:00Z");

describe("localParts", () => {
  test("gives the wall clock in the reader's zone, not the server's", () => {
    const instant = new Date("2026-10-01T02:30:00Z");
    assert.deepEqual(localParts("Asia/Kolkata", instant), { date: "2026-10-01", time: "08:00", weekday: 4 });
    assert.deepEqual(localParts("America/Los_Angeles", instant), { date: "2026-09-30", time: "19:30", weekday: 3 });
    assert.deepEqual(localParts("UTC", instant), { date: "2026-10-01", time: "02:30", weekday: 4 });
  });

  test("midnight is 00:00, never 24:00", () => {
    assert.equal(localParts("UTC", new Date("2026-10-01T00:00:00Z")).time, "00:00");
  });

  test("an unknown or missing zone falls back to UTC instead of throwing", () => {
    const instant = new Date("2026-10-01T02:30:00Z");
    assert.equal(localParts("Mars/Olympus_Mons", instant).time, "02:30");
    assert.equal(localParts(null, instant).time, "02:30");
  });
});

describe("evaluateDue: who", () => {
  test("a new reader with one module is due once their send time has passed", () => {
    const result = evaluateDue(profile(), [sub()], THU_0900);
    assert.equal(result.due, true);
    assert.deepEqual(result.modules, ["digest"]);
    assert.equal(result.slot, "2026-10-01");
  });

  test("not before the send time", () => {
    const result = evaluateDue(profile({ send_time: "09:30" }), [sub()], THU_0900);
    assert.equal(result.due, false);
    assert.match(result.reason, /before send time/);
  });

  test("the send time is judged in the reader's timezone", () => {
    // 02:30 UTC is 08:00 in Kolkata and still the previous evening in Los Angeles.
    const instant = new Date("2026-10-01T02:30:00Z");
    assert.equal(evaluateDue(profile({ timezone: "Asia/Kolkata" }), [sub()], instant).due, true);
    assert.equal(evaluateDue(profile({ timezone: "UTC" }), [sub()], instant).due, false);

    const la = evaluateDue(profile({ timezone: "America/Los_Angeles" }), [sub()], instant);
    assert.equal(la.due, true, "19:30 local is past an 08:00 send time");
    assert.equal(la.slot, "2026-09-30", "and the slot is their date, not the server's");
  });

  test("never while paused, and never before onboarding is finished", () => {
    assert.equal(evaluateDue(profile({ is_paused: true }), [sub()], THU_0900).due, false);
    assert.equal(evaluateDue(profile({ onboarded_at: null }), [sub()], THU_0900).due, false);
  });

  test("nothing to send with no modules, or only inactive ones", () => {
    assert.equal(evaluateDue(profile(), [], THU_0900).due, false);
    assert.equal(evaluateDue(profile(), [sub({ is_active: false })], THU_0900).due, false);
  });

  test("a malformed send time falls back to the default rather than blocking forever", () => {
    assert.equal(evaluateDue(profile({ send_time: "whenever" }), [sub()], THU_0900).due, true);
  });
});

describe("evaluateDue: cadence", () => {
  const sentAgo = (hours: number) => new Date(THU_0900.getTime() - hours * 3_600_000).toISOString();

  test("daily: due again the next day, not later the same day", () => {
    assert.equal(evaluateDue(profile(), [sub({ last_sent_at: sentAgo(3) })], THU_0900).due, false);
    assert.equal(evaluateDue(profile(), [sub({ last_sent_at: sentAgo(24) })], THU_0900).due, true);
  });

  test("daily does not drift when the previous issue went out late in the day", () => {
    // The first issue after signing up was sent at 21:00 yesterday. Today's is
    // still due at the reader's 08:00, eleven hours later, not pushed to the
    // afternoon by an "hours since last send" rule.
    const at0800 = new Date("2026-10-01T08:00:00Z");
    const lastNight = "2026-09-30T21:00:00Z";
    assert.equal(evaluateDue(profile(), [sub({ last_sent_at: lastNight })], at0800).due, true);
  });

  test("daily counts the reader's dates, not UTC's", () => {
    // 20:00 UTC on Sep 30 is already 05:00 on Oct 1 in Tokyo. An issue sent
    // then belongs to the reader's Oct 1, so it is not due again that day.
    const tokyo = profile({ timezone: "Asia/Tokyo", send_time: "04:00" });
    const sent = "2026-09-30T20:00:00Z";
    assert.equal(evaluateDue(tokyo, [sub({ last_sent_at: sent })], new Date("2026-10-01T03:00:00Z")).due, false);
    assert.equal(evaluateDue(tokyo, [sub({ last_sent_at: sent })], new Date("2026-10-01T20:00:00Z")).due, true);
  });

  test("weekly comes round on the same weekday", () => {
    const weekly = (lastSent: string) =>
      evaluateDue(profile(), [sub({ frequency: "weekly", last_sent_at: lastSent })], THU_0900).due;
    assert.equal(weekly("2026-09-28T08:00:00Z"), false, "sent Monday");
    assert.equal(weekly("2026-09-25T08:00:00Z"), false, "sent last Friday, six days ago");
    // Last Thursday, and it went out in the evening that time. Still due today
    // at the normal hour.
    assert.equal(weekly("2026-09-24T19:00:00Z"), true);
  });

  test("custom uses its own interval, clamped to sane bounds", () => {
    const custom = (days: number, hours: number) =>
      evaluateDue(
        profile(),
        [sub({ frequency: "custom", custom_interval_days: days, last_sent_at: sentAgo(hours) })],
        THU_0900
      ).due;
    assert.equal(custom(3, 24 * 2), false);
    assert.equal(custom(3, 24 * 3), true);
    assert.equal(custom(1, 24), true);

    assert.equal(frequencyDays({ frequency: "custom", custom_interval_days: 0 }), 1);
    assert.equal(frequencyDays({ frequency: "custom", custom_interval_days: 5000 }), 90);
    assert.equal(frequencyDays({ frequency: "custom", custom_interval_days: null }), 7);
  });

  test("weekdays skips Saturday and Sunday in the reader's own week", () => {
    const weekdays = [sub({ frequency: "weekdays" })];
    assert.equal(evaluateDue(profile(), weekdays, new Date("2026-10-02T09:00:00Z")).due, true, "Friday");
    assert.equal(evaluateDue(profile(), weekdays, new Date("2026-10-03T09:00:00Z")).due, false, "Saturday");
    assert.equal(evaluateDue(profile(), weekdays, new Date("2026-10-04T09:00:00Z")).due, false, "Sunday");
    assert.equal(evaluateDue(profile(), weekdays, new Date("2026-10-05T09:00:00Z")).due, true, "Monday");

    // Friday 23:00 UTC is already Saturday morning in Tokyo.
    const tokyo = profile({ timezone: "Asia/Tokyo" });
    assert.equal(evaluateDue(tokyo, weekdays, new Date("2026-10-02T23:30:00Z")).due, false);
  });
});

describe("evaluateDue: bundling", () => {
  test("everything due at once goes in one issue, in section order", () => {
    const result = evaluateDue(
      profile(),
      [sub({ module: "learn" }), sub({ module: "dev_pulse" }), sub({ module: "digest" }), sub({ module: "repo_guard" })],
      THU_0900
    );
    // Things that need action first, reading last.
    assert.deepEqual(result.modules, ["repo_guard", "digest", "dev_pulse", "learn"]);
  });

  test("a module that is not due yet is left out of today's issue", () => {
    const result = evaluateDue(
      profile(),
      [
        sub({ module: "digest" }),
        sub({ module: "dev_pulse", frequency: "weekly", last_sent_at: new Date(THU_0900.getTime() - 86_400_000).toISOString() }),
      ],
      THU_0900
    );
    assert.deepEqual(result.modules, ["digest"]);
  });

  test("EOL Watch rides along but never triggers a send by itself", () => {
    const eol = sub({ module: "eol_watch" });
    assert.equal(evaluateDue(profile(), [eol], THU_0900).due, false);

    const together = evaluateDue(profile(), [eol, sub({ module: "digest" })], THU_0900);
    assert.equal(together.due, true);
    assert.deepEqual(together.modules, ["eol_watch", "digest"]);
  });
});

describe("daysBetween", () => {
  test("counts calendar days, across months and years", () => {
    assert.equal(daysBetween("2026-10-01", "2026-10-01"), 0);
    assert.equal(daysBetween("2026-09-30", "2026-10-01"), 1);
    assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
    assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
    assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2, "a leap year");
    assert.equal(daysBetween("2026-10-08", "2026-10-01"), -7);
  });
});

describe("coverageDays", () => {
  test("covers the cadence plus a day of overlap, capped at a month", () => {
    assert.equal(coverageDays({ frequency: "daily" }), 2);
    assert.equal(coverageDays({ frequency: "weekly" }), 8);
    assert.equal(coverageDays({ frequency: "monthly" }), 31);
    assert.equal(coverageDays({ frequency: "custom", custom_interval_days: 90 }), 31);
  });
});

describe("dedupe keys", () => {
  test("the same logical send always produces the same key", () => {
    assert.equal(buildDedupeKey("scheduled", "u1", "2026-10-01"), "scheduled:u1:2026-10-01");
    assert.equal(buildDedupeKey("scheduled", "u1", "2026-10-01"), buildDedupeKey("scheduled", "u1", "2026-10-01"));
  });

  test("different readers, days and kinds never collide", () => {
    const keys = new Set([
      buildDedupeKey("scheduled", "u1", "2026-10-01"),
      buildDedupeKey("scheduled", "u2", "2026-10-01"),
      buildDedupeKey("scheduled", "u1", "2026-10-02"),
      buildDedupeKey("manual", "u1", "2026-10-01"),
    ]);
    assert.equal(keys.size, 4);
  });

  test("a double click within the same minute is one send", () => {
    const first = manualSlot(new Date("2026-10-01T09:00:05Z"));
    const second = manualSlot(new Date("2026-10-01T09:00:55Z"));
    const later = manualSlot(new Date("2026-10-01T09:01:05Z"));
    assert.equal(first, second);
    assert.notEqual(first, later);
  });
});
