// The options the virtualizer is constructed with, driven one at a time. Each must reach
// machinery this frame owns rather than the platform (an unnamed `scrollTo`, a second scroll
// listener, a second `ResizeObserver` on the same box). The row heights they hand the library are
// driven through the mounted binding, a row reporting its size through the library's own
// observer as the platform's would.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import { installFakeResizeObserver } from "#test/helpers/element/resize.js";
import { ViewportController } from "./controller.js";
import type { TranscriptRowVirtualizer } from "./virtualizer-options.js";
import { attachedController, syntheticRows } from "./controller.test-support.js";
import {
  MOUNTED_ROW_COUNT,
  MOUNTED_ROW_ESTIMATE_PX,
  MOUNTED_ROW_WIDTH_PX,
  attachRow,
  mountViewport,
  reportRowSize,
} from "./hooks/useTranscriptViewport.test-support.js";

/**
 * The instance argument the two observer options ignore; both read the chokepoint, so it is typed
 * rather than constructed.
 */
const UNUSED_VIRTUALIZER = undefined as unknown as TranscriptRowVirtualizer;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the virtualizer options — what the library is allowed to reach", () => {
  it("routes the library's own scroll write through the chokepoint, named for whom it is made", () => {
    // The default `scrollToFn` calls `scrollElement.scrollTo`, which names neither a caller nor
    // an amount: the write the chokepoint exists to prevent. The same resize compensation is the
    // end anchor keeping a follower on the tail, and a reader's compensation once they read.
    const { controller } = attachedController();
    controller.virtualizerOptions.scrollToFn(120, { adjustments: 30 });
    expect(controller.scroll.writeCount("follow-tail")).toBe(1);

    controller.anchor.readFrom("row-0");
    controller.virtualizerOptions.scrollToFn(120, { adjustments: 30 });
    expect(controller.scroll.writeCount("measurement-compensation")).toBe(1);
  });

  it("feeds the library's offset and rect from ONE scroll listener", () => {
    // The library's own offset and rect observers attach their own listener and observer; two
    // sources for one box let two readers disagree about where the reader is.
    const scrollContainer = createCountingScrollContainer();
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    const offsets: number[] = [];
    const heights: number[] = [];
    controller.virtualizerOptions.observeElementOffset(UNUSED_VIRTUALIZER, (offset) =>
      offsets.push(offset),
    );
    controller.virtualizerOptions.observeElementRect(UNUSED_VIRTUALIZER, (rect) =>
      heights.push(rect.height),
    );
    expect(scrollContainer.scrollListenerCount()).toBe(1);
    // Resent on subscribe, so a pane mounted mid-stream knows where it is.
    expect(offsets).toStrictEqual([40]);
    expect(heights).toStrictEqual([300]);
  });

  it("gives the library a new viewport rect when the box changes without a scroll", () => {
    // The library's own rect observer runs a `ResizeObserver`; this frame replaces it, so a
    // resize reaches the virtualizer through this subscription or not at all.
    const resizeObserver = installFakeResizeObserver();
    const scrollContainer = createCountingScrollContainer({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    const heights: number[] = [];
    controller.virtualizerOptions.observeElementRect(UNUSED_VIRTUALIZER, (rect) =>
      heights.push(rect.height),
    );

    scrollContainer.resizeTo(260, 4000);
    resizeObserver.deliverFor(scrollContainer, 260);
    clock.runFrame();

    expect(heights).toStrictEqual([300, 260]);
  });

  it("a pass over an unchanged box gives it nothing to re-lay-out", () => {
    // Otherwise the case above passes over a seam that republished on every pass, a full
    // re-layout per measurement frame.
    const scrollContainer = createCountingScrollContainer({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    const heights: number[] = [];
    controller.virtualizerOptions.observeElementRect(UNUSED_VIRTUALIZER, (rect) =>
      heights.push(rect.height),
    );

    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(heights).toStrictEqual([300]);
  });
});

describe("the virtualizer options — the heights a row is laid out at", () => {
  it("measures a row as it lands without reading it, and compensates once it reports", () => {
    // The library measures a row synchronously as it mounts, with no observation; reading the
    // element then forces a layout per row. The observer reports the real box before the frame
    // paints, and a row above the reader that differs from its estimate must still be paid for
    // in that report, or the reader slides by the difference.
    const subject = mountViewport(600);
    const offsetHeightReads = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    const rectReads = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const sizeBeforePx = subject.virtualizer.measurementsCache[1]?.size;

    const element = attachRow(subject, 1);

    expect(offsetHeightReads).not.toHaveBeenCalled();
    expect(rectReads).not.toHaveBeenCalled();
    expect(subject.virtualizer.measurementsCache[1]?.size).toBe(sizeBeforePx);
    expect(subject.controller.measurements.rememberedHeightOf("row-1")).toBeUndefined();

    reportRowSize(subject, element, 230);

    expect(subject.scrollContainer.scrollTop).toBeCloseTo(600 + 230 - MOUNTED_ROW_ESTIMATE_PX, 6);
    expect(subject.controller.scroll.writeCount("measurement-compensation")).toBe(1);
  });

  it("lays out a transcript mounted again at the heights its rows measured", () => {
    // A session opened again whose rows fall back to estimates lays the transcript out anew,
    // and the reader watches it settle row by row.
    const rememberedRowHeights = new RememberedRowHeights();
    const first = mountViewport("tail", rememberedRowHeights);
    const measuredHeightsPx = [90, 210, 333];
    for (const [index, heightPx] of measuredHeightsPx.entries()) {
      reportRowSize(first, attachRow(first, index), heightPx);
    }
    first.binding.unmount();

    const second = mountViewport("tail", rememberedRowHeights);

    expect(second.controller).not.toBe(first.controller);
    expect(
      measuredHeightsPx.map(
        (_heightPx, index) => second.virtualizer.measurementsCache[index]?.size,
      ),
    ).toStrictEqual(measuredHeightsPx);
    expect(second.virtualizer.measurementsCache[3]?.size).toBe(MOUNTED_ROW_ESTIMATE_PX);

    // A new width lets the session's heights go, and the next append lays every row out again;
    // a row laid out at a remembered height keeps it until it measures, so nothing above moves.
    reportRowSize(second, attachRow(second, 5), 150, MOUNTED_ROW_WIDTH_PX - 200);
    expect(rememberedRowHeights.heightOf("row-0")).toBeUndefined();
    act(() => {
      second.binding.rerender(syntheticRows(MOUNTED_ROW_COUNT + 1));
    });
    expect(
      measuredHeightsPx.map(
        (_heightPx, index) => second.virtualizer.measurementsCache[index]?.size,
      ),
    ).toStrictEqual(measuredHeightsPx);
  });

  it("drops the remembered heights for a new transcript width, and keeps them for a new height", () => {
    // A narrower transcript rewraps every row, so a kept height would lay a reopened transcript
    // out at the old wrap; a row that only grew changed nothing about the others.
    const rememberedRowHeights = new RememberedRowHeights();
    const subject = mountViewport("tail", rememberedRowHeights);
    const firstRow = attachRow(subject, 0);
    const secondRow = attachRow(subject, 1);
    reportRowSize(subject, firstRow, 120);
    reportRowSize(subject, secondRow, 140);

    reportRowSize(subject, secondRow, 260);
    expect(rememberedRowHeights.heightOf("row-0")).toBe(120);

    reportRowSize(subject, secondRow, 300, MOUNTED_ROW_WIDTH_PX - 200);
    expect(rememberedRowHeights.heightOf("row-0")).toBeUndefined();
    expect(rememberedRowHeights.heightOf("row-1")).toBe(300);
  });
});
