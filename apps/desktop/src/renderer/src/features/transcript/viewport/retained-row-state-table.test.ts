// Parking a dropped row's lease, and the bound on the parked table. Both fail silently: a
// dropped lease reads as a row never expanded, and an unbounded table shows only in a long
// session's memory.

import { describe, expect, it } from "vitest";

import { RetainedRowStateTable } from "./retained-row-state-table.js";

const EXPANDED = { density: "expanded", innerScrollTopPx: 44 } as const;

describe("the row-lease table — parking, not dropping", () => {
  it("answers from the live table first, so a re-read row's current state wins", () => {
    const table = new RetainedRowStateTable();
    table.setLease("run-group-0", EXPANDED);
    table.park("run-group-0");
    table.setLease("run-group-0", { density: "collapsed", innerScrollTopPx: 0 });
    expect(table.lease("run-group-0")?.density).toBe("collapsed");
  });
});

describe("the row-lease table — the parked bound", () => {
  it("evicts the least recently parked once the bound is passed", () => {
    const table = new RetainedRowStateTable(2);
    for (const index of [0, 1, 2]) {
      table.setLease(`run-group-${String(index)}`, {
        density: "expanded",
        innerScrollTopPx: index,
      });
    }
    for (const index of [0, 1, 2]) {
      table.park(`run-group-${String(index)}`);
    }
    expect(table.parkedCount).toBe(2);
    expect(table.lease("run-group-0")).toBeUndefined();
    expect(table.lease("run-group-1")?.innerScrollTopPx).toBe(1);
    expect(table.lease("run-group-2")?.innerScrollTopPx).toBe(2);
  });

  it("releases every parked lease at once, and keeps every live one", () => {
    // Live leases belong to rows the window still holds.
    const table = new RetainedRowStateTable(4);
    for (const key of ["run-group-0", "run-group-1"]) {
      table.setLease(key, EXPANDED);
      table.park(key);
    }
    table.setLease("run-group-2", EXPANDED);

    expect(table.releaseParkedLeases()).toBe(2);
    expect(table.parkedCount).toBe(0);
    expect(table.lease("run-group-0")).toBeUndefined();
    expect(table.lease("run-group-2")).toStrictEqual(EXPANDED);
  });
});
