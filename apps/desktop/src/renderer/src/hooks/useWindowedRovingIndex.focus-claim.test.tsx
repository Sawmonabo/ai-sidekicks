// A claim on the page's focus is spent once, and only ever armed for somewhere to go.
//
// Two defects, one subject. A claim that outlives its move: a press whose row the window
// never mounted left a standing flag, and an unrelated store update later found the row
// mounted and pulled focus out of what the reader was typing in. And a claim armed for a move
// that goes nowhere: `End` on the last row lands on the row already active, so no run is left
// to spend the claim, and the same steal follows from a key that asked for nothing.
//
// The list and the scans are in `RovingList.test-support.tsx` and
// `useWindowedRovingIndex.test-support.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ListWithNeighbor, neighborOf } from "./ListWithNeighbor.test-support.js";
import { RovingList } from "./RovingList.test-support.js";
import { listOf, pressEnd, tabbableIndexes } from "./useWindowedRovingIndex.test-support.js";

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

  it("negative control: the one retry a reveal needs still lands the focus", async () => {
    // Without this the expiry above would also be satisfied by dropping the move on the first
    // miss, which is every asynchronous virtualizer: the row is mounted a render later and
    // the key press would move nothing. An expiry keyed on the option's identity does exactly
    // that here, because `mountedIndexes` is a new array on the very render the move's own
    // state update causes.
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    rerender(
      <RovingList rowCount={40} windowStart={36} windowLength={4} onReveal={() => undefined} />,
    );
    expect(document.activeElement?.textContent).toBe("row 39");
  });

  it("focuses no other row when the set narrows under a pending move", async () => {
    // A list that shrank between the key press and the mount must not answer a press about
    // row 39 by focusing row 4 (the clamped index).
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    rerender(
      <RovingList rowCount={5} windowStart={0} windowLength={5} onReveal={() => undefined} />,
    );
    // Row 4 is mounted and is the active index; it is still not what was asked for.
    expect(list.querySelector('li[data-index="4"]')).not.toBeNull();
    expect(document.activeElement?.textContent).not.toBe("row 4");
    expect(document.activeElement).toBe(document.body);
  });
});
describe("useWindowedRovingIndex — a move to the row the keyboard is on arms nothing", () => {
  it("leaves focus where the reader put it when End is pressed at the end", async () => {
    // `End` on the last row stores a claim for a row that is already active, so nothing spends
    // it. The reader tabs away and types; an unrelated window revision later runs the effect
    // with row 39 mounted and pulls focus back out of what they were typing in.
    const { container, rerender } = render(
      <ListWithNeighbor rowCount={40} windowStart={0} windowLength={40} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    expect(document.activeElement?.textContent).toBe("row 39");

    await pressEnd(list);
    const neighbor = neighborOf(container);
    neighbor.focus();
    rerender(<ListWithNeighbor rowCount={40} windowStart={0} windowLength={40} />);
    expect(document.activeElement).toBe(neighbor);
  });

  it("still moves for a key whose landing place is a different row", async () => {
    // The guard is on the index being unchanged, not on the key, so `End` from anywhere but
    // the end still arms, reveals and lands.
    const { container } = render(
      <ListWithNeighbor rowCount={40} windowStart={0} windowLength={40} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    expect(document.activeElement?.textContent).toBe("row 39");
    expect(tabbableIndexes(list)).toStrictEqual(["39"]);
  });

  it("negative control: a claim that WAS armed does take focus on the same revision", async () => {
    // Without this, the first case would also pass against a harness whose rerender never
    // re-runs the effect, or a hook that had stopped moving focus at all. Same shape, same
    // rerender, but the move goes somewhere, and focus is taken off the neighbor.
    const { container, rerender } = render(
      <ListWithNeighbor rowCount={40} windowStart={0} windowLength={4} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    const neighbor = neighborOf(container);
    neighbor.focus();
    rerender(<ListWithNeighbor rowCount={40} windowStart={36} windowLength={4} />);
    expect(document.activeElement).not.toBe(neighbor);
    expect(document.activeElement?.textContent).toBe("row 39");
  });
});
