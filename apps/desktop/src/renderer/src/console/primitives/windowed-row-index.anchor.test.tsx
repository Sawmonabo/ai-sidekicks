// An anchor the mounted window does not hold, driven.
//
// The defect in terms: a list reopened on a selected row starts its keyboard there,
// and a window mounts the rows a SCROLL POSITION needs. Where the two disagreed the
// hook made the unmounted row active, every mounted row was rendered
// `isTabbable={false}`, and the list held no sequential tab stop at all — the same
// reachability failure the clamp exists for, arriving through the anchor rather than
// through a narrowed set. The caller was silently required to have scrolled the
// anchor into view first, which is a rule no caller can check.
//
// So two claims are driven here: the anchor is ASKED FOR, and until it arrives the
// nearest mounted row holds the stop. The list and the Tab scans come from
// `windowed-row-index.test-support.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  RovingList,
  listOf,
  sequentialTabStops,
  tabbableIndexes,
} from "./windowed-row-index.test-support.js";

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
    // Rows 0..3 are mounted and the anchor is 30, so the stop is row 3 — the mounted
    // row closest to it — and there is exactly one.
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
    // A render that changes nothing must not re-ask: a virtualizer hands back a fresh
    // window value every render, so an unguarded reveal would fire on every one.
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
    // The shipped shape, stated as the scan that finds it: a window that mounts rows
    // 0..3 while the active index is 30 has every mounted row at `tabindex="-1"`, so
    // Tab reaches nothing in the list. Rendered directly here — not through the hook —
    // because the hook no longer produces it, and the claims above are only findings
    // if this is what they rule out.
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
