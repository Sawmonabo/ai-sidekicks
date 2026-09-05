// A move belongs to the sequence it was made in, driven.
//
// The defect the clamp does not reach, measured on a changed-file list: five hundred
// rows, the reader arrows to 499, a filter narrows the list to three. The clamp keeps
// the list reachable — that is its whole job and it does it — by moving the keyboard
// to row 2, a row nobody moved to. Then the filter clears, the drawing is five hundred
// rows again, the remembered move is 499 again, and the window is back at the top: the
// keyboard is now on a row that has to be scrolled to, and the list scrolls itself
// there because the anchor machinery asks for whatever the roving row is.
//
// So the sentence the clamp cannot say is said by `rowSetIdentity`: an index means a
// row only inside one drawn sequence. A move made under a different one is DROPPED and
// the stop falls back to the anchor, which is a position in the sequence on screen.
//
// The list and the Tab scans come from `RovingList.test-support.tsx` /
// `windowed-row-index.test-support.ts`. Each drawing gets a FRESH identity value,
// which is what a caller passing the array it drew actually hands over.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RovingList } from "./RovingList.test-support.js";
import { clampedRowIndex } from "./windowed-row-index.js";
import { listOf, pressEnd, tabbableIndexes } from "./windowed-row-index.test-support.js";

/** One drawing's identity. Fresh per call, the way a re-derived row array is. */
function drawnSequence(): readonly string[] {
  return ["a-drawing"];
}

describe("useWindowedRovingIndex — a move belongs to the sequence it was made in", () => {
  it("drops a move made under a different drawing, and falls back to the anchor", async () => {
    const wholeList = drawnSequence();
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={40}
        anchorIndex={0}
        rowSetIdentity={wholeList}
        onReveal={() => undefined}
      />,
    );
    const list = listOf(container);
    await pressEnd(list);
    expect(tabbableIndexes(list)).toStrictEqual(["39"]);

    rerender(
      <RovingList
        rowCount={3}
        windowStart={0}
        windowLength={3}
        anchorIndex={0}
        rowSetIdentity={drawnSequence()}
        onReveal={() => undefined}
      />,
    );
    // Row 2 is what the clamp answers and it is not what this hook does: the move was
    // made in a list that is no longer drawn, so it is dropped rather than reinterpreted.
    expect(clampedRowIndex(39, 3)).toBe(2);
    expect(tabbableIndexes(list)).toStrictEqual(["0"]);
  });

  it("does not scroll a redrawn list to a row the reader never moved to", async () => {
    // The round trip the defect is named for: narrow, then clear. A remembered 39
    // over a window sitting at the top is a row the list has to be scrolled to, and
    // the reveal is where that scroll would be asked for.
    const onReveal = vi.fn();
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={0}
        rowSetIdentity={drawnSequence()}
        onReveal={onReveal}
      />,
    );
    const list = listOf(container);
    await pressEnd(list);
    expect(onReveal).toHaveBeenCalledWith(39);

    rerender(
      <RovingList
        rowCount={3}
        windowStart={0}
        windowLength={3}
        anchorIndex={0}
        rowSetIdentity={drawnSequence()}
        onReveal={onReveal}
      />,
    );
    onReveal.mockClear();
    rerender(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={0}
        rowSetIdentity={drawnSequence()}
        onReveal={onReveal}
      />,
    );

    expect(onReveal).not.toHaveBeenCalled();
    expect(tabbableIndexes(list)).toStrictEqual(["0"]);
  });

  it("negative control: without the option the same round trip restores the move", async () => {
    // Same fixture, same three renders, one difference — no identity is stated — and
    // the remembered 39 comes back over a window that mounts rows 0..3, which is the
    // list asking to be scrolled to a row nobody moved to. Without this the two cases
    // above would also be satisfied by a hook that had simply stopped remembering
    // moves at all.
    const onReveal = vi.fn();
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={onReveal} />,
    );
    const list = listOf(container);
    await pressEnd(list);

    rerender(<RovingList rowCount={3} windowStart={0} windowLength={3} onReveal={onReveal} />);
    onReveal.mockClear();
    rerender(<RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={onReveal} />);

    expect(onReveal).toHaveBeenCalledWith(39);
    // The stand-in holds the stop meanwhile, so the list is reachable — and it is
    // reachable at a row the reader is not on, which is the half the clamp cannot fix.
    expect(tabbableIndexes(list)).toStrictEqual(["3"]);
  });

  it("keeps a move while the drawing is the same value", async () => {
    // Identity and not equality: the same sequence re-rendered keeps the keyboard
    // where the reader put it, or every render would reset the list.
    const wholeList = drawnSequence();
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={40}
        rowSetIdentity={wholeList}
        onReveal={() => undefined}
      />,
    );
    const list = listOf(container);
    await pressEnd(list);
    rerender(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={40}
        rowSetIdentity={wholeList}
        onReveal={() => undefined}
      />,
    );

    expect(tabbableIndexes(list)).toStrictEqual(["39"]);
  });

  it("takes no focus into the redrawn list when the pending move is dropped", async () => {
    // The claim armed by the key press names row 39 of a list that is no longer
    // drawn. A drawing that happens to mount a row 39 must not answer it.
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        rowSetIdentity={drawnSequence()}
        onReveal={() => undefined}
      />,
    );
    const list = listOf(container);
    await pressEnd(list);
    rerender(
      <RovingList
        rowCount={40}
        windowStart={36}
        windowLength={4}
        rowSetIdentity={drawnSequence()}
        onReveal={() => undefined}
      />,
    );

    expect(document.activeElement).toBe(document.body);
    // And the list stays reachable while it waits for the anchor: the stand-in holds
    // the stop on the mounted row nearest row 0, which is the anchor machinery doing
    // its own job over a keyboard position this rule just corrected.
    expect(tabbableIndexes(list)).toStrictEqual(["36"]);
  });
});
