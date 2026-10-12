import { type Range } from "@tanstack/virtual-core";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useDirectlyPlacedVirtualizer } from "./useDirectlyPlacedVirtualizer.js";

/** Rows ten pixels tall, in a box thirty pixels tall scrolled to 250: rows 25 to 27 show. */
const ROW_HEIGHT_PX = 10;
const BOX_HEIGHT_PX = 30;
const SCROLL_OFFSET_PX = 250;

/** Draws the rows in view rounded out to whole tens, as a band drawn past the box does. */
function drawnTensOf(range: Range): number[] {
  const first = Math.floor(range.startIndex / 10) * 10;
  const last = Math.min(range.count - 1, Math.floor(range.endIndex / 10) * 10 + 9);
  return Array.from({ length: last - first + 1 }, (_unused, offset) => first + offset);
}

function renderCountedVirtualizer(): {
  readonly renders: () => number;
  readonly firstRowInView: () => number | undefined;
  readonly resizeFirstRow: (sizePx: number) => void;
} {
  let renders = 0;
  const scrollElement = document.createElement("div");
  const { result } = renderHook(() => {
    renders += 1;
    const virtualizer = useDirectlyPlacedVirtualizer<HTMLElement, HTMLElement>({
      count: 100,
      estimateSize: () => ROW_HEIGHT_PX,
      getScrollElement: () => scrollElement,
      scrollToFn: () => undefined,
      observeElementRect: () => undefined,
      observeElementOffset: () => undefined,
      initialRect: { width: 100, height: BOX_HEIGHT_PX },
      initialOffset: SCROLL_OFFSET_PX,
      overscan: 0,
      rangeExtractor: drawnTensOf,
    });
    // The rows follow the box's place and never move it, however a row measures.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    return virtualizer;
  });
  return {
    renders: () => renders,
    firstRowInView: () => result.current.range?.startIndex,
    resizeFirstRow: (sizePx) => {
      act(() => {
        result.current.resizeItem(0, sizePx);
      });
    },
  };
}

describe("useDirectlyPlacedVirtualizer", () => {
  it("renders again for a measured row only when the rows it draws change", () => {
    const list = renderCountedVirtualizer();
    const settledRenders = list.renders();

    // Row 0 grows by 5: row 24 comes into view, but rows 20 to 29 are still the ones drawn.
    list.resizeFirstRow(ROW_HEIGHT_PX + 5);
    expect(list.firstRowInView()).toBe(24);
    expect(list.renders()).toBe(settledRenders);

    // Row 0 grows by 90: row 16 is at the top, so rows 10 to 29 are drawn.
    list.resizeFirstRow(ROW_HEIGHT_PX + 90);
    expect(list.renders()).toBe(settledRenders + 1);
  });
});
