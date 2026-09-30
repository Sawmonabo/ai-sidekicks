// Cases walk a four-tab strip in both directions, since a subtraction applied both ways or
// neither passes a single case. The oracle is a real splice: each case compares the resulting
// order, not the arithmetic the module performs.

import { describe, expect, it } from "vitest";

import {
  PAGE_TAB_DRAG_MEDIA_TYPE,
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

function dragTransfer(): DataTransfer {
  return new DataTransfer();
}

describe("the tab drop-position translation", () => {
  it("moves a tab rightward to the place it was dropped", () => {
    const moveIndex = pageMoveIndex(0, 3);
    expect(moveIndex).toBe(2);
    expect(reorderPages(0, 2)).toStrictEqual(["beta", "gamma", "alpha", "delta"]);
  });

  it("moves a tab leftward without subtracting", () => {
    const moveIndex = pageMoveIndex(3, 1);
    expect(moveIndex).toBe(1);
    expect(reorderPages(3, 1)).toStrictEqual(["alpha", "delta", "beta", "gamma"]);
  });

  it("reaches the last position through the trailing drop position", () => {
    const moveIndex = pageMoveIndex(0, PAGES.length);
    expect(moveIndex).toBe(PAGES.length - 1);
    expect(reorderPages(0, PAGES.length - 1)).toStrictEqual(["beta", "gamma", "delta", "alpha"]);
  });

  it("answers nothing for a drop at the tab's own position", () => {
    expect(pageMoveIndex(2, 2)).toBeUndefined();
  });

  it("answers nothing for a drop at the position immediately after the tab", () => {
    // Drop position 3 for the tab at index 2 is the position it already occupies.
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
    transfer.setData(PAGE_TAB_DRAG_MEDIA_TYPE, "");
    expect(readTabDragPayload(transfer)).toBeUndefined();
  });
});
