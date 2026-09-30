import { describe, expect, it } from "vitest";

import { HeadInsertion } from "./viewport-head-insertion.js";
import { type ViewportRow } from "./viewport-snapshot.js";

function rowsFrom(keys: readonly string[]): readonly ViewportRow[] {
  return keys.map((key) => ({ key, parentKey: undefined, rootCursor: `cursor-${key}` }));
}

describe("the head-growth reading", () => {
  it("reports nothing on the first set it is shown", () => {
    // Every row is new but none arrived under anybody: there was no window for a page to land
    // in front of.
    expect(new HeadInsertion().read(rowsFrom(["c", "d"]))).toEqual({
      insertedCount: 0,
      headRootCursor: undefined,
    });
  });

  it("counts the rows a page brought and names the cursor they start at", () => {
    const growth = new HeadInsertion();
    growth.read(rowsFrom(["c", "d"]));

    expect(growth.read(rowsFrom(["a", "b", "c", "d"]))).toEqual({
      insertedCount: 2,
      headRootCursor: "cursor-a",
    });
  });

  it("reports nothing for rows appended at the tail", () => {
    const growth = new HeadInsertion();
    growth.read(rowsFrom(["c", "d"]));

    expect(growth.read(rowsFrom(["c", "d", "e"]))).toEqual({
      insertedCount: 0,
      headRootCursor: undefined,
    });
  });

  it("negative control: a set re-supplied after the cap trimmed reports nothing", () => {
    // The cap takes rows from the oldest end and the feed keeps handing over the whole
    // projection, so those rows lead the next set. Against the retained head that reads as a page
    // arriving; against the incoming head it is an ordinary reconcile.
    const growth = new HeadInsertion();
    const whole = rowsFrom(["a", "b", "c", "d"]);
    growth.read(whole);

    expect(growth.read(whole)).toEqual({ insertedCount: 0, headRootCursor: undefined });
  });

  it("reports nothing when the set no longer carries the head it last saw", () => {
    // A different session's rows, or a rebuilt window: the remembered key names nothing, so
    // there is no origin and no shift to undo.
    const growth = new HeadInsertion();
    growth.read(rowsFrom(["c", "d"]));

    expect(growth.read(rowsFrom(["x", "y"]))).toEqual({
      insertedCount: 0,
      headRootCursor: undefined,
    });
  });
});
