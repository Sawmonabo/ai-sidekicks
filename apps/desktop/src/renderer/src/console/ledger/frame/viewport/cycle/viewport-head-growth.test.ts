import { describe, expect, it } from "vitest";

import { LedgerHeadGrowth } from "./viewport-head-growth.js";
import { type LedgerViewportRow } from "../surface/viewport-snapshot.js";

function rowsFrom(keys: readonly string[]): readonly LedgerViewportRow[] {
  return keys.map((key) => ({ key, parentKey: undefined, rootCursor: `cursor-${key}` }));
}

describe("the head-growth reading", () => {
  it("reports nothing on the first set it is shown", () => {
    // Every row is new and none of them arrived UNDER anybody: there was no window
    // for a page to land in front of.
    expect(new LedgerHeadGrowth().read(rowsFrom(["c", "d"]))).toEqual({
      insertedCount: 0,
      headRootCursor: undefined,
    });
  });

  it("counts the rows a page brought and names the cursor they start at", () => {
    const growth = new LedgerHeadGrowth();
    growth.read(rowsFrom(["c", "d"]));

    expect(growth.read(rowsFrom(["a", "b", "c", "d"]))).toEqual({
      insertedCount: 2,
      headRootCursor: "cursor-a",
    });
  });

  it("reports nothing for rows appended at the tail", () => {
    const growth = new LedgerHeadGrowth();
    growth.read(rowsFrom(["c", "d"]));

    expect(growth.read(rowsFrom(["c", "d", "e"]))).toEqual({
      insertedCount: 0,
      headRootCursor: undefined,
    });
  });

  it("negative control: a set re-supplied after the cap trimmed reports nothing", () => {
    // THE CASE THAT DECIDES WHICH KEY THIS OBJECT REMEMBERS. The window's cap takes
    // rows from the oldest end and the surrounding surface keeps handing over the
    // whole projection, so the rows the cap took are back at the front of the very
    // next set. Read against the RETAINED head this is a page of history arriving;
    // read against the incoming one it is the ordinary reconcile it actually is.
    const growth = new LedgerHeadGrowth();
    const whole = rowsFrom(["a", "b", "c", "d"]);
    growth.read(whole);

    expect(growth.read(whole)).toEqual({ insertedCount: 0, headRootCursor: undefined });
  });

  it("reports nothing when the set no longer carries the head it last saw", () => {
    // A different session's rows, or a window rebuilt from scratch: the key it
    // remembered names nothing, so there is no origin for the arithmetic and no
    // shift to undo.
    const growth = new LedgerHeadGrowth();
    growth.read(rowsFrom(["c", "d"]));

    expect(growth.read(rowsFrom(["x", "y"]))).toEqual({
      insertedCount: 0,
      headRootCursor: undefined,
    });
  });
});
