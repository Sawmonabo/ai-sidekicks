// An anchor the mounted window does not hold, driven.
//
// A list reopened on a selected row starts its keyboard there, while a window mounts the
// rows a scroll position needs. If the two disagree and the unmounted row is made active,
// every mounted row is `isTabbable={false}` and the list has no sequential tab stop, the
// same reachability failure the clamp prevents for a narrowed set.
//
// Two claims are driven: the anchor is asked for, and until it arrives the nearest mounted
// row holds the stop. The list and the Tab scans are in `RovingList.test-support.tsx` and
// `useWindowedRovingIndex.test-support.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RovingList } from "./RovingList.test-support.js";
import {
  listOf,
  sequentialTabStops,
  tabbableIndexes,
} from "./useWindowedRovingIndex.test-support.js";

describe("useWindowedRovingIndex — an anchor outside the mounted window", () => {
  it("asks the window for the anchor rather than assuming it is mounted", () => {
    const onReveal = vi.fn();
    render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={30}
        onReveal={onReveal}
      />,
    );
    expect(onReveal).toHaveBeenCalledWith(30);
  });

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

  it("hands the stop back to the anchor once the window produces it", () => {
    const { container, rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={30}
        onReveal={() => undefined}
      />,
    );
    const list = listOf(container);
    expect(tabbableIndexes(list)).toStrictEqual(["3"]);
    rerender(
      <RovingList
        rowCount={40}
        windowStart={28}
        windowLength={4}
        anchorIndex={30}
        onReveal={() => undefined}
      />,
    );
    expect(tabbableIndexes(list)).toStrictEqual(["30"]);
  });

  it("reveals a changed anchor and asks for each index once", () => {
    const onReveal = vi.fn();
    const { rerender } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={30}
        onReveal={onReveal}
      />,
    );
    // A render that changes nothing must not re-ask: a virtualizer hands back a fresh window
    // value every render, so an unguarded reveal would fire on every one.
    rerender(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={30}
        onReveal={onReveal}
      />,
    );
    expect(onReveal.mock.calls).toStrictEqual([[30]]);
    rerender(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={17}
        onReveal={onReveal}
      />,
    );
    expect(onReveal.mock.calls).toStrictEqual([[30], [17]]);
  });

  it("leaves an anchor the window already holds alone", () => {
    const onReveal = vi.fn();
    const { container } = render(
      <RovingList
        rowCount={40}
        windowStart={0}
        windowLength={4}
        anchorIndex={2}
        onReveal={onReveal}
      />,
    );
    // Nothing to ask for and nothing to stand in: the stop is the anchor itself.
    expect(onReveal).not.toHaveBeenCalled();
    expect(tabbableIndexes(listOf(container))).toStrictEqual(["2"]);
  });

  it("negative control: an unrevealed anchor leaves the list with no tab stop at all", () => {
    // A window that mounts rows 0..3 while the active index is 30 has every mounted row at
    // `tabindex="-1"`, so Tab reaches nothing in the list. Rendered directly, not through the
    // hook, which no longer produces it; the claims above rule this out.
    const { container } = render(
      <ul>
        {[0, 1, 2, 3].map((rowIndex) => (
          <li key={rowIndex} data-index={rowIndex}>
            <button
              type="button"
              data-row-target=""
              tabIndex={-1}
            >{`row ${String(rowIndex)}`}</button>
          </li>
        ))}
      </ul>,
    );
    expect(tabbableIndexes(container)).toStrictEqual([]);
    expect(sequentialTabStops(container)).toStrictEqual([]);
  });
});
