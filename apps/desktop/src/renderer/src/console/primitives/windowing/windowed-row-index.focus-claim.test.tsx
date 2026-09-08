// A claim on the page's focus is spent once, and only ever armed for somewhere to go.
//
// Two defects, one subject. The first is a claim that outlives its move: a press whose
// row the window never mounted left a standing flag, and an unrelated store update
// thirty seconds later found the row mounted and pulled focus out of what the reader
// was typing in. The second is a claim that could never be spent at all: `End` on the
// last row arms for the index the roving state already holds, so no render follows and
// no effect run exists to consume it — the same steal, reached by a key that asked for
// nothing.
//
// The list and the two scans come from `RovingList.test-support.tsx` / `windowed-row-index.test-support.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ListWithNeighbour, neighbourOf } from "./ListWithNeighbour.test-support.js";
import { RovingList } from "./RovingList.test-support.js";
import { listOf, pressEnd, tabbableIndexes } from "./windowed-row-index.test-support.js";

describe("useWindowedRovingIndex — a pending move is spent once, never left standing", () => {
  it("does not steal focus on a later window change once the move has expired", async () => {
    // The defect in terms: the reader presses End, the window never mounts row 39,
    // they tab away and start typing — and an unrelated store update re-runs the
    // effect with the row mounted, pulling focus out of what they were typing in.
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);

    // One more render that does not bring row 39 in. That is the move's one retry,
    // and it is spent here.
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
    // Without this the expiry above would also be satisfied by dropping the move on
    // the first miss, which is every asynchronous virtualizer: the row is mounted a
    // render later and the key press would move nothing at all. That is exactly what
    // an expiry keyed on the option's identity does here, because `mountedIndexes` is
    // a new array on the very render the move's own state update causes.
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
    // The second arm of the same defect: the effect keyed on the CLAMPED index, so
    // a list that shrank between the key press and the mount answered a press about
    // row 39 by focusing row 4.
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
    // The defect in terms: `End` on the last row stores a claim for a row that is
    // ALREADY active, so `setMovedToIndex` writes the value it holds, React schedules
    // no render, and nothing spends the claim. The reader tabs away and types; an
    // unrelated window revision later runs the effect with row 39 mounted and pulls
    // focus back out of what they were typing in.
    const { container, rerender } = render(
      <ListWithNeighbour rowCount={40} windowStart={0} windowLength={40} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    expect(document.activeElement?.textContent).toBe("row 39");

    await pressEnd(list);
    const neighbour = neighbourOf(container);
    neighbour.focus();
    rerender(<ListWithNeighbour rowCount={40} windowStart={0} windowLength={40} />);
    expect(document.activeElement).toBe(neighbour);
  });

  it("still moves for a key whose landing place is a different row", async () => {
    // The other half: the guard is on the INDEX being unchanged, not on the key, so
    // `End` from anywhere but the end still arms, still reveals, and still lands.
    const { container } = render(
      <ListWithNeighbour rowCount={40} windowStart={0} windowLength={40} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    expect(document.activeElement?.textContent).toBe("row 39");
    expect(tabbableIndexes(list)).toStrictEqual(["39"]);
  });

  it("negative control: a claim that WAS armed does take focus on the same revision", async () => {
    // Without this, the first case would also pass against a harness whose rerender
    // never re-runs the effect, or against a hook that had stopped moving focus at
    // all. Same shape, same rerender, one difference — the move goes somewhere — and
    // focus is taken off the neighbour, which is the steal the first case denies.
    const { container, rerender } = render(
      <ListWithNeighbour rowCount={40} windowStart={0} windowLength={4} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    const neighbour = neighbourOf(container);
    neighbour.focus();
    rerender(<ListWithNeighbour rowCount={40} windowStart={36} windowLength={4} />);
    expect(document.activeElement).not.toBe(neighbour);
    expect(document.activeElement?.textContent).toBe("row 39");
  });
});
