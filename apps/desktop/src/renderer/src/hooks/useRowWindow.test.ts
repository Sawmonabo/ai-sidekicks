// A list window never writes its box's offset itself: the opening, a row reveal and the
// compensation for a row measured above the fold each reach the box through the scroll
// chokepoint, named for what made them. The box is a real element with its geometry defined onto
// it, because `happy-dom` answers zero for every geometry read.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { useRowWindow } from "./useRowWindow.js";

const ROW_COUNT = 1_000;
const ROW_HEIGHT_PX = 20;
const VIEWPORT_HEIGHT_PX = 300;
const OPENING_OFFSET_PX = 800;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a list window's scroll writes", () => {
  it("opens, reveals and compensates through the scroll chokepoint, each write named", () => {
    const glideTo = vi.spyOn(ScrollController.prototype, "glideTo");
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 0,
      clientHeight: VIEWPORT_HEIGHT_PX,
      scrollHeight: ROW_COUNT * ROW_HEIGHT_PX,
    });
    const { result } = renderHook(() =>
      useRowWindow({
        rowCount: ROW_COUNT,
        // The fixture builds a `<div>`, the element every list window scrolls.
        getScrollElement: () =>
          scrollContainer instanceof HTMLDivElement ? scrollContainer : null,
        clock: new ManualClock(),
        estimateRowHeightPx: () => ROW_HEIGHT_PX,
        overscanRows: 2,
        initialViewportHeightPx: VIEWPORT_HEIGHT_PX,
        initialOffsetPx: OPENING_OFFSET_PX,
      }),
    );

    // The box opens where the window does: a selection far down the list is in view at once.
    expect(glideTo.mock.calls).toEqual([["window-opening", OPENING_OFFSET_PX]]);
    expect(scrollContainer.scrollTop).toBe(OPENING_OFFSET_PX);

    // A row above the fold measuring taller than its estimate moves the rows under the reader;
    // the window offers to follow, and that write is compensation, not the opening.
    glideTo.mockClear();
    const grownByPx = 10;
    act(() => {
      result.current.virtualizer.resizeItem(0, ROW_HEIGHT_PX + grownByPx);
    });
    expect(glideTo.mock.calls).toEqual([
      ["measurement-compensation", OPENING_OFFSET_PX + grownByPx],
    ]);

    glideTo.mockClear();
    const reaimFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      reaimFrames.push(frame);
      return reaimFrames.length;
    });
    const revealedRowIndex = 500;
    act(() => {
      result.current.revealRow(revealedRowIndex);
    });
    // The row sat far below the box; the reveal's write is the one that brought the box to it.
    const [revealCaller, revealOffsetPx] = glideTo.mock.calls[0] ?? [];
    expect(revealCaller).toBe("row-reveal");
    expect(revealOffsetPx).toBeGreaterThanOrEqual(revealedRowIndex * ROW_HEIGHT_PX);
    expect(scrollContainer.scrollTop).toBe(revealOffsetPx);

    // A drawn row above the target measures before the reveal settles: the library re-aims on its
    // next frame, and that write is still the reveal's.
    const drawnRowIndex = result.current.virtualizer.getVirtualItems().at(-1)?.index ?? 0;
    act(() => {
      result.current.virtualizer.resizeItem(drawnRowIndex, ROW_HEIGHT_PX + grownByPx);
    });
    glideTo.mockClear();
    act(() => {
      reaimFrames.shift()?.(0);
    });
    expect(glideTo.mock.calls.map(([caller]) => caller)).toEqual(["row-reveal"]);
  });
});
