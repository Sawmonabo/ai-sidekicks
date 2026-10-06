// The two pure rules the viewport folds a render's conditions through, asserted directly.
// Reaching them through the controller means building four live objects, and the arms that
// matter most (a vanished tail key, a row straddling the fold) are the ones that path reaches
// least. Wiring claims live in `controller.test.ts`.

import { describe, expect, it } from "vitest";

import {
  shouldCompensateForInsertion,
  countAppendedAfter,
  countInsertedBefore,
  type ViewportRow,
} from "./snapshot.js";

/** A retained window, spelled the way `controller.test.ts` spells one. */
const RETAINED_ROWS: readonly ViewportRow[] = ["a", "b", "c", "d"].map((key) => ({
  key,
  parentKey: undefined,
  rootCursor: `cursor-${key}`,
}));

describe("counting rows appended after the previous tail", () => {
  it("counts every row that arrived after the row that used to be last", () => {
    expect(countAppendedAfter(RETAINED_ROWS, "b")).toBe(2);
    expect(countAppendedAfter(RETAINED_ROWS, "c")).toBe(1);
  });

  it("counts nothing when there was no previous window", () => {
    // Not "every row is new": the anchor counts rows that arrived under a reader, and a reader
    // who was not there has nothing to be told.
    expect(countAppendedAfter(RETAINED_ROWS, undefined)).toBe(0);
    expect(countAppendedAfter([], undefined)).toBe(0);
  });

  it("counts nothing when the previous tail was pruned out of the window", () => {
    // The named row is gone, so there is no origin. Returning `rows.length`, as a naive
    // `indexOf` fallback would, announces the whole window as new on the first reconcile after a
    // prune.
    expect(countAppendedAfter(RETAINED_ROWS, "pruned-away")).toBe(0);
  });
});

describe("counting rows inserted before the previous head", () => {
  it("counts nothing when there was no previous window", () => {
    expect(countInsertedBefore(RETAINED_ROWS, undefined)).toBe(0);
    expect(countInsertedBefore([], undefined)).toBe(0);
  });

  it("counts nothing when the previous head is no longer in the set", () => {
    // The mirror of the pruned-tail arm: answering `rows.length` would arm a head hold on every
    // reconcile that dropped the first row.
    expect(countInsertedBefore(RETAINED_ROWS, "pruned-away")).toBe(0);
  });
});

describe("compensating for a row that grew above the fold", () => {
  it("compensates for a row that ends at or above the reader's offset", () => {
    expect(shouldCompensateForInsertion("reading", 400, 400)).toBe(true);
    expect(shouldCompensateForInsertion("reading", 120, 400)).toBe(true);
  });

  it("refuses a row the reader can see growing", () => {
    // A row ending one pixel below the fold is growing under the reader's eyes; subtracting its
    // delta would drag the viewport down every frame of a stream and loop through the anchor.
    expect(shouldCompensateForInsertion("reading", 401, 400)).toBe(false);
  });

  it("refuses every row while the reader is following", () => {
    // The tail glide already puts a follower at the bottom and a compensation would fight it;
    // this fails even for a row that clears the fold by a mile.
    expect(shouldCompensateForInsertion("following", 0, 400)).toBe(false);
    expect(shouldCompensateForInsertion("following", 400, 400)).toBe(false);
  });
});
