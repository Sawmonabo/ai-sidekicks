// A dropped row's leased state, and the bound the parked table is held to.
//
// Both rules fail SILENTLY. A lease dropped instead of parked reads as a row the
// person never expanded, and an unbounded parked table reads as nothing at all until
// a long session's memory reading is taken. Each clean case is paired with the
// control that fails when the rule is removed.

import { describe, expect, it } from "vitest";

import { LedgerRowLeaseTable } from "./row-lease-table.js";

const EXPANDED = { density: "expanded", innerScrollTopPx: 44 } as const;

describe("the row-lease table — parking, not dropping", () => {
  it("hands a parked lease back under the row's own key", () => {
    const table = new LedgerRowLeaseTable();
    table.setLease("chapter-0", EXPANDED);
    table.park("chapter-0");
    expect(table.parkedCount).toBe(1);
    expect(table.lease("chapter-0")).toStrictEqual(EXPANDED);
  });

  it("negative control: a row that leased nothing parks nothing", () => {
    // Without this the case above would pass over a table that parked every key it
    // was handed, filling the bounded table with rows nobody had expanded and
    // evicting the ones somebody had.
    const table = new LedgerRowLeaseTable();
    table.park("chapter-0");
    expect(table.parkedCount).toBe(0);
    expect(table.lease("chapter-0")).toBeUndefined();
  });

  it("answers from the live table first, so a re-read row's current state wins", () => {
    const table = new LedgerRowLeaseTable();
    table.setLease("chapter-0", EXPANDED);
    table.park("chapter-0");
    table.setLease("chapter-0", { density: "collapsed", innerScrollTopPx: 0 });
    expect(table.lease("chapter-0")?.density).toBe("collapsed");
  });
});

describe("the row-lease table — the parked bound", () => {
  it("evicts the least recently parked once the bound is passed", () => {
    const table = new LedgerRowLeaseTable(2);
    for (const index of [0, 1, 2]) {
      table.setLease(`chapter-${String(index)}`, { density: "expanded", innerScrollTopPx: index });
    }
    for (const index of [0, 1, 2]) {
      table.park(`chapter-${String(index)}`);
    }
    expect(table.parkedCount).toBe(2);
    expect(table.lease("chapter-0")).toBeUndefined();
    expect(table.lease("chapter-1")?.innerScrollTopPx).toBe(1);
    expect(table.lease("chapter-2")?.innerScrollTopPx).toBe(2);
  });

  it("negative control: under the bound nothing is evicted at all", () => {
    // Without this the case above would pass over a table that evicted on every
    // park, which would lose the row a person had open a moment ago.
    const table = new LedgerRowLeaseTable(2);
    table.setLease("chapter-0", EXPANDED);
    table.setLease("chapter-1", EXPANDED);
    table.park("chapter-0");
    table.park("chapter-1");
    expect(table.parkedCount).toBe(2);
    expect(table.lease("chapter-0")).toStrictEqual(EXPANDED);
  });

  it("re-parking a row keeps it, and moves it to the most recently parked end", () => {
    const table = new LedgerRowLeaseTable(2);
    for (const key of ["chapter-0", "chapter-1"]) {
      table.setLease(key, EXPANDED);
      table.park(key);
    }
    table.setLease("chapter-0", { density: "expanded", innerScrollTopPx: 9 });
    table.park("chapter-0");
    table.setLease("chapter-2", EXPANDED);
    table.park("chapter-2");
    expect(table.lease("chapter-1")).toBeUndefined();
    expect(table.lease("chapter-0")?.innerScrollTopPx).toBe(9);
  });
});
