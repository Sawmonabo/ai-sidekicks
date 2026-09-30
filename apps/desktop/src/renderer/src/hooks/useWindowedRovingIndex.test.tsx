// The list stays reachable by Tab, and a move never pulls focus from where the reader went.
//
// A list reopened on a selected row the window has not mounted would make every mounted row
// untabbable, so the list leaves the page's tab order. And a claim on focus that outlives its move
// lets an unrelated store update pull focus out of what the reader was typing in. The list and the
// Tab scans are `RovingList.test-support.tsx` and `useWindowedRovingIndex.test-support.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RovingList } from "./RovingList.test-support.js";
import {
  listOf,
  pressEnd,
  sequentialTabStops,
  tabbableIndexes,
} from "./useWindowedRovingIndex.test-support.js";

describe("useWindowedRovingIndex — an anchor outside the mounted window", () => {
  it("puts the list's one tab stop on the nearest mounted row meanwhile", () => {
    const { container } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={30}
        onReveal={() => undefined}
      />,
    );
    const list = listOf(container);
    // Rows 0..3 are mounted and the anchor is 30, so the stop is row 3, the mounted row
    // closest to it, and there is exactly one.
    expect(tabbableIndexes(list)).toStrictEqual(["3"]);
    expect(sequentialTabStops(list).map((element) => element.tagName)).toStrictEqual(["BUTTON"]);
  });
});

describe("useWindowedRovingIndex — a pending move is spent once, never left standing", () => {
  it("does not steal focus on a later window change once the move has expired", async () => {
    // The reader presses End, the window never mounts row 39, they tab away and start
    // typing, and an unrelated store update re-runs the effect with the row mounted, pulling
    // focus out of what they were typing in.
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);

    // One more render that does not bring row 39 in: the move's one retry is spent here.
    rerender(
      <RovingList rowCount={40} windowStart={4} windowLength={4} onReveal={() => undefined} />,
    );
    // A later window change that DOES mount it must move nothing.
    rerender(
      <RovingList rowCount={40} windowStart={36} windowLength={4} onReveal={() => undefined} />,
    );
    expect(document.activeElement?.textContent).not.toBe("row 39");
    expect(document.activeElement).toBe(document.body);
  });
});
