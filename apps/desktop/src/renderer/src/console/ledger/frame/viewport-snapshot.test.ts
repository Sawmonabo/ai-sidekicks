// The two pure rules the viewport folds a render's conditions through.
//
// They were private methods on the controller, and while they were, the only way
// to reach either was to build four live objects, attach a scroll surface and
// drive a reconcile — so the arms that matter most were the ones no case reached:
// a tail key the retained set no longer holds, and a row that STRADDLES the fold
// rather than sitting clear of it. `viewport-controller.test.ts` still owns the
// wiring claims and is not narrowed; what is added here is the boundary arithmetic
// underneath them, asserted directly because it now can be.

import { describe, expect, it } from "vitest";

import {
  compensatesForGrowth,
  countAppendedAfter,
  type LedgerViewportRow,
} from "./viewport-snapshot.js";

/** A retained window, spelled the way `viewport-controller.test.ts` spells one. */
const RETAINED_ROWS: readonly LedgerViewportRow[] = ["a", "b", "c", "d"].map((key) => ({
  key,
  parentKey: undefined,
  rootCursor: `cursor-${key}`,
}));

describe("counting rows appended after the previous tail", () => {
  it("counts every row that arrived after the row that used to be last", () => {
    expect(countAppendedAfter(RETAINED_ROWS, "b")).toBe(2);
    expect(countAppendedAfter(RETAINED_ROWS, "c")).toBe(1);
  });

  it("counts nothing when the previous tail is still the tail", () => {
    expect(countAppendedAfter(RETAINED_ROWS, "d")).toBe(0);
  });

  it("counts nothing when there was no previous window", () => {
    // Not "every row is new": the anchor counts rows that arrived UNDER a reader,
    // and a reader who was not there has nothing to be told about.
    expect(countAppendedAfter(RETAINED_ROWS, undefined)).toBe(0);
    expect(countAppendedAfter([], undefined)).toBe(0);
  });

  it("counts nothing when the previous tail was pruned out of the window", () => {
    // The row the key named is gone, so the arithmetic that would follow it has no
    // origin. Returning `rows.length` here — the shape a naive `indexOf` fallback
    // produces — would announce the whole window as newly arrived on the first
    // reconcile after a prune.
    expect(countAppendedAfter(RETAINED_ROWS, "pruned-away")).toBe(0);
  });
});

describe("compensating for a row that grew above the fold", () => {
  it("compensates for a row that ends at or above the reader's offset", () => {
    expect(compensatesForGrowth("reading", 400, 400)).toBe(true);
    expect(compensatesForGrowth("reading", 120, 400)).toBe(true);
  });

  it("negative control: refuses a row the reader can see growing", () => {
    // A row ending one pixel below the fold is growing under the reader's eyes.
    // Subtracting its delta drags the viewport down every frame of a stream, and
    // each drag moves the anchor, which notifies, which renders, which glides.
    expect(compensatesForGrowth("reading", 401, 400)).toBe(false);
  });

  it("negative control: refuses every row while the reader is following", () => {
    // The tail glide already puts a follower at the bottom; a compensation would
    // fight it. Both conjuncts are load-bearing, so this arm fails even for a row
    // that clears the fold by a mile.
    expect(compensatesForGrowth("following", 0, 400)).toBe(false);
    expect(compensatesForGrowth("following", 400, 400)).toBe(false);
  });
});
