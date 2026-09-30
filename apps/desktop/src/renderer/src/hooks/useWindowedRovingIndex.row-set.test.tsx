// A move belongs to the sequence it was made in, driven.
//
// The defect the clamp does not reach: five hundred rows, the reader arrows to 499, a filter
// narrows the list to three, and the clamp keeps the list reachable by moving the keyboard to
// row 2, a row nobody moved to. When the filter clears, the remembered move is 499 again over
// a window back at the top, and the list scrolls itself to a row the reader never chose
// because the anchor machinery asks for whatever the roving row is.
//
// `rowSetIdentity` says what the clamp cannot: an index means a row only inside one drawn
// sequence. A move made under a different one is dropped and the stop falls back to the
// anchor. The list and the Tab scans are in `RovingList.test-support.tsx` and
// `useWindowedRovingIndex.test-support.ts`. Each drawing gets a fresh identity value, as a
// caller passing the array it drew does.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RovingList } from "./RovingList.test-support.js";
import { clampedRowIndex } from "./useWindowedRovingIndex.js";
import { listOf, pressEnd, tabbableIndexes } from "./useWindowedRovingIndex.test-support.js";

/** One drawing's identity, fresh per call like a re-derived row array. */
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
    // The clamp answers row 2, which is not what this hook does: the move was made in a list
    // that is no longer drawn, so it is dropped rather than reinterpreted.
    expect(clampedRowIndex(39, 3)).toBe(2);
    expect(tabbableIndexes(list)).toStrictEqual(["0"]);
  });

  it("does not scroll a redrawn list to a row the reader never moved to", async () => {
    // The round trip: narrow, then clear. A remembered 39 over a window sitting at the top is
    // a row the list has to be scrolled to, and the reveal is where that scroll is asked for.
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
    // Same fixture, same three renders, but no identity stated: the remembered 39 comes back
    // over a window that mounts rows 0..3, the list asking to be scrolled to a row nobody
    // moved to. Without this the two cases above would also be satisfied by a hook that had
    // stopped remembering moves.
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
    // The stand-in holds the stop meanwhile, so the list is reachable, but at a row the reader
    // is not on, which the clamp cannot fix.
    expect(tabbableIndexes(list)).toStrictEqual(["3"]);
  });

  it("keeps a move while the drawing is the same value", async () => {
    // Identity, not equality: the same sequence re-rendered keeps the keyboard where the
    // reader put it, or every render would reset the list.
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
    // The claim armed by the key press names row 39 of a list that is no longer drawn; a
    // drawing that happens to mount a row 39 must not answer it.
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
    // The list stays reachable while it waits for the anchor: the stand-in holds the stop on
    // the mounted row nearest row 0.
    expect(tabbableIndexes(list)).toStrictEqual(["36"]);
  });

  it("takes no focus when the redrawn list puts an unrelated row at the claimed index", async () => {
    // The dropped move does not answer this case, because the move and the claim are separate
    // values: the move is discarded by its identity and the keyboard falls back to the anchor,
    // so a redrawing whose own anchor sits at the claimed number hands the claim the roving
    // index it waits for. Row 39 of the list that was read and row 39 of a re-filtered one are
    // different rows, so the claim must not be spent on the second.
    const firstDrawing = drawnSequence();
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={0}
        rowSetIdentity={firstDrawing}
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
        anchorIndex={39}
        rowSetIdentity={drawnSequence()}
        onReveal={() => undefined}
      />,
    );

    expect(list.querySelector('li[data-index="39"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    // The anchor still holds the stop, so the redrawn list is reachable without the reader's
    // focus being pulled into it.
    expect(tabbableIndexes(list)).toStrictEqual(["39"]);
  });

  it("negative control: the same script under one drawing does land the focus", async () => {
    // Identical to the case above except the second render is the same sequence, so the claim
    // is spent as a move still on screen must be. Without it, "focus went nowhere" would be
    // satisfied by a hook that had stopped honoring pending claims, or a fixture whose rerender
    // never mounted row 39.
    const oneDrawing = drawnSequence();
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={0}
        rowSetIdentity={oneDrawing}
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
        anchorIndex={39}
        rowSetIdentity={oneDrawing}
        onReveal={() => undefined}
      />,
    );

    expect(document.activeElement?.textContent).toBe("row 39");
  });
});
