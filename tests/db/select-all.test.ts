import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { selectAll } from "@/lib/supabase-admin";

/** A stand-in for a table of `total` rows, served a page at a time. */
function table(total: number) {
  const calls: [number, number][] = [];
  const build = async (from: number, to: number) => {
    calls.push([from, to]);
    const data = [];
    for (let i = from; i <= to && i < total; i++) data.push({ id: i });
    return { data, error: null };
  };
  return { build, calls };
}

describe("selectAll", () => {
  test("returns everything when it fits in one page", async () => {
    const { build, calls } = table(3);
    assert.deepEqual(await selectAll(build), [{ id: 0 }, { id: 1 }, { id: 2 }]);
    assert.deepEqual(calls, [[0, 999]]);
  });

  test("keeps reading past the 1,000-row cap", async () => {
    const { build, calls } = table(2400);
    const rows = await selectAll(build);
    assert.equal(rows.length, 2400);
    assert.equal(rows[2399].id, 2399);
    assert.deepEqual(calls, [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  test("a table of exactly one page is not mistaken for a complete read", async () => {
    // 1,000 rows back could mean "that was all" or "there is more". The only
    // way to know is to ask for the next page.
    const { build, calls } = table(1000);
    assert.equal((await selectAll(build)).length, 1000);
    assert.equal(calls.length, 2);
  });

  test("no row is returned twice or skipped", async () => {
    const rows = await selectAll(table(3500).build);
    assert.equal(new Set(rows.map((r) => r.id)).size, 3500);
  });

  test("an empty table is an empty array", async () => {
    assert.deepEqual(await selectAll(table(0).build), []);
  });

  test("a null page is treated as the end", async () => {
    assert.deepEqual(await selectAll(async () => ({ data: null, error: null })), []);
  });

  test("an error stops the read and is raised, never swallowed as a short result", async () => {
    let page = 0;
    const build = async () => {
      page++;
      if (page === 2) return { data: null, error: { message: "connection reset" } };
      return { data: new Array(1000).fill({ id: 1 }), error: null };
    };
    await assert.rejects(() => selectAll(build), /connection reset/);
  });
});
