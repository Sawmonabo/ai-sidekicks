// The drop-slot translation, exercised in the direction that is easy to get wrong.
//
// The rightward case is the whole reason `pageMoveIndex` exists, so the cases below
// walk a four-tab strip rather than asserting one number: a subtraction applied in
// both directions, or in neither, passes a single-case test and reorders wrongly on
// every drag one way.
//
// THE ORACLE IS A REAL SPLICE. Each case moves the page in a copy of the list using
// the index the function returned and compares the resulting ORDER, so a case says
// what a person would see rather than restating the arithmetic the module performs —
// which is the reimplementation `apps/desktop/AGENTS.md` rejects.

import { describe, expect, it } from "vitest";

import {
  BROWSER_TAB_DRAG_MEDIA_TYPE,
  isTabDrag,
  pageMoveIndex,
  readTabDragPayload,
  writeTabDragPayload,
} from "./tab-reorder.js";

const PAGES = ["alpha", "beta", "gamma", "delta"] as const;

/** Apply a move the way a registry would: take the page out, then put it back. */
function reorderPages(fromIndex: number, moveIndex: number): readonly string[] {
  const remaining = [...PAGES];
  const [moved] = remaining.splice(fromIndex, 1);
  if (moved === undefined) {
    throw new Error("the case named a page the strip does not hold");
  }
  remaining.splice(moveIndex, 0, moved);
  return remaining;
}

/** A `DataTransfer` a jsdom drag event would carry. */
function dragTransfer(): DataTransfer {
  return new DataTransfer();
}

describe("the tab drop-slot translation", () => {
  it("moves a tab rightward to the place it was dropped", () => {
    // `alpha` (index 0) dropped in the slot between `gamma` and `delta` (slot 3).
    const moveIndex = pageMoveIndex(0, 3);
    expect(moveIndex).toBe(2);
    expect(reorderPages(0, 2)).toStrictEqual(["beta", "gamma", "alpha", "delta"]);
  });

  it("moves a tab leftward without subtracting", () => {
    // `delta` (index 3) dropped in the slot between `alpha` and `beta` (slot 1).
    const moveIndex = pageMoveIndex(3, 1);
    expect(moveIndex).toBe(1);
    expect(reorderPages(3, 1)).toStrictEqual(["alpha", "delta", "beta", "gamma"]);
  });

  it("reaches the last position through the trailing slot", () => {
    const moveIndex = pageMoveIndex(0, PAGES.length);
    expect(moveIndex).toBe(PAGES.length - 1);
    expect(reorderPages(0, PAGES.length - 1)).toStrictEqual(["beta", "gamma", "delta", "alpha"]);
  });

  it("answers nothing for a drop in the tab's own slot", () => {
    expect(pageMoveIndex(2, 2)).toBeUndefined();
  });

  it("answers nothing for a drop in the slot immediately after the tab", () => {
    // Slot 3 for the tab at index 2 names the position it already occupies, and the
    // subtraction is what reveals that — the negative control for the case above.
    expect(pageMoveIndex(2, 3)).toBeUndefined();
  });
});

describe("the tab drag payload", () => {
  it("round-trips a page id on the private type", () => {
    const transfer = dragTransfer();
    writeTabDragPayload(transfer, "page-7");
    expect(isTabDrag(transfer)).toBe(true);
    expect(readTabDragPayload(transfer)).toBe("page-7");
    expect(transfer.effectAllowed).toBe("move");
  });

  it("reads nothing off a drag that is not this strip's", () => {
    const transfer = dragTransfer();
    transfer.setData("text/plain", "page-7");
    expect(isTabDrag(transfer)).toBe(false);
    expect(readTabDragPayload(transfer)).toBeUndefined();
  });

  it("reads nothing off an empty payload on the right type", () => {
    const transfer = dragTransfer();
    transfer.setData(BROWSER_TAB_DRAG_MEDIA_TYPE, "");
    expect(readTabDragPayload(transfer)).toBeUndefined();
  });
});
