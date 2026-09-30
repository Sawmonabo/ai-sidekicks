// Parking a dropped row's lease, and the bound on the parked table. Both fail silently: a
// dropped lease reads as a row never expanded, and an unbounded table shows only in a long
// session's memory.

import { describe, expect, it } from "vitest";

import { RetainedRowStateTable } from "./retained-row-state-table.js";

const EXPANDED = { density: "expanded", innerScrollTopPx: 44 } as const;

describe("the row-lease table — parking, not dropping", () => {
  it("hands a parked lease back under the row's own key", () => {
    const table = new RetainedRowStateTable();
    table.setLease("run-group-0", EXPANDED);
    table.park("run-group-0");
    expect(table.parkedCount).toBe(1);
    expect(table.lease("run-group-0")).toStrictEqual(EXPANDED);
  });

  it("negative control: a row that leased nothing parks nothing", () => {
    // Without this the case above passes over a table that parks every key, evicting rows
    // somebody expanded.
    const table = new RetainedRowStateTable();
    table.park("run-group-0");
    expect(table.parkedCount).toBe(0);
    expect(table.lease("run-group-0")).toBeUndefined();
  });

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

  it("negative control: under the bound nothing is evicted at all", () => {
    // Without this the case above passes over a table that evicts on every park.
    const table = new RetainedRowStateTable(2);
    table.setLease("run-group-0", EXPANDED);
    table.setLease("run-group-1", EXPANDED);
    table.park("run-group-0");
    table.park("run-group-1");
    expect(table.parkedCount).toBe(2);
    expect(table.lease("run-group-0")).toStrictEqual(EXPANDED);
  });

  it("re-parking a row keeps it, and moves it to the most recently parked end", () => {
    const table = new RetainedRowStateTable(2);
    for (const key of ["run-group-0", "run-group-1"]) {
      table.setLease(key, EXPANDED);
      table.park(key);
    }
    table.setLease("run-group-0", { density: "expanded", innerScrollTopPx: 9 });
    table.park("run-group-0");
    table.setLease("run-group-2", EXPANDED);
    table.park("run-group-2");
    expect(table.lease("run-group-1")).toBeUndefined();
    expect(table.lease("run-group-0")?.innerScrollTopPx).toBe(9);
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

  it("releases nothing when nothing is parked", () => {
    // A release answering with the live size would report memory returned that is still held.
    const table = new RetainedRowStateTable(4);
    table.setLease("run-group-0", EXPANDED);
    expect(table.releaseParkedLeases()).toBe(0);
    expect(table.lease("run-group-0")).toStrictEqual(EXPANDED);
  });
});
