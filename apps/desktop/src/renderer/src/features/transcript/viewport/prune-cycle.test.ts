// When a reader's scroll asks the window to let rows go: as the window's first row, read to its near
// edge as the cut reads it, crosses the let-go distance. No virtualizer is bound, so every row sits
// at the measurement table's estimate and a row's place in the content is that arithmetic.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { type ScrollGeometry } from "#renderer/lib/scroll/geometry/sample.js";
import { TRANSCRIPT_LET_GO_SCREEN_HEIGHTS, TRANSCRIPT_RETAINED_SCREEN_HEIGHTS } from "./caps.js";
import { CALM, syntheticRows } from "./controller.test-support.js";
import { ViewportPruneCycle } from "./prune-cycle.js";
import { ReadingAnchor } from "./reading-anchor.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { TranscriptWindow } from "./window-cap.js";

const VIEWPORT_HEIGHT_PX = 300;
const READER_ROW_INDEX = 200;

describe("the window's cycle — the cut a reader's scroll asks for", () => {
  it("lets the first row go once its near edge, not the content's top, crosses the distance", () => {
    const clock = new ManualClock();
    const scroll = new ScrollController({ clock });
    scroll.attach(
      createCountingScrollContainer({
        initialScrollTop: 0,
        clientHeight: VIEWPORT_HEIGHT_PX,
        scrollHeight: 400_000,
      }),
    );
    const anchor = new ReadingAnchor();
    const measurements = new RowMeasurementTable();
    const rowWindow = new TranscriptWindow();
    const rowHeightPx = measurements.heightOf("row-0");
    const publishedRowKeys = (): readonly string[] => rowWindow.rows().map((row) => row.key);
    const publishedIndexOf = (rowKey: string): number | undefined => {
      const index = publishedRowKeys().indexOf(rowKey);
      return index < 0 ? undefined : index;
    };
    const cycle = new ViewportPruneCycle({
      window: rowWindow,
      measurements,
      anchor,
      scroll,
      clock,
      virtualizer: () => undefined,
      publishedRowKeys,
      publishedIndexOf,
      rowStartPx: (rowKey) => {
        const index = publishedIndexOf(rowKey);
        return index === undefined ? undefined : index * rowHeightPx;
      },
      readBeyondLogEdge: undefined,
    });
    // The log ends inside the share the window keeps below the reader, so the window holds the
    // log's tail and the reader's way toward it admits nothing: only a cut moves the head.
    const retainedPx = TRANSCRIPT_RETAINED_SCREEN_HEIGHTS * VIEWPORT_HEIGHT_PX;
    const rows = syntheticRows(READER_ROW_INDEX + Math.ceil(retainedPx / rowHeightPx));
    const conditions = { rows, ...CALM };
    anchor.readFrom(`row-${String(READER_ROW_INDEX)}`);
    cycle.run(conditions);
    const headRowKey = publishedRowKeys()[0];
    // The reader's scroll sample at `scrollTopPx`, reading the row at the viewport's top.
    const sampleAt = (scrollTopPx: number, inputAtMs: number): void => {
      const topIndex = Math.floor(scrollTopPx / rowHeightPx);
      anchor.capture({
        rowKey: publishedRowKeys()[topIndex] ?? expect.fail("the window holds the top row"),
        offsetWithinViewportPx: topIndex * rowHeightPx - scrollTopPx,
      });
      const contentHeightPx = publishedRowKeys().length * rowHeightPx;
      const geometry: ScrollGeometry = {
        scrollTop: scrollTopPx,
        viewportHeight: VIEWPORT_HEIGHT_PX,
        contentHeight: contentHeightPx,
        distanceFromTailPx: contentHeightPx - scrollTopPx - VIEWPORT_HEIGHT_PX,
        isAtTail: false,
        inputAt: inputAtMs,
        cause: "scroll",
      };
      const request = cycle.passOwedBy(geometry);
      if (request !== undefined) {
        cycle.run(conditions, request.admitSide);
      }
    };
    const letGoPx = TRANSCRIPT_LET_GO_SCREEN_HEIGHTS * VIEWPORT_HEIGHT_PX;

    sampleAt(letGoPx / 2, 1_000);
    // The content's top is past the distance, the first row's bottom edge half a row short of it.
    sampleAt(letGoPx + rowHeightPx / 2, 1_016);
    expect(publishedRowKeys()[0]).toBe(headRowKey);
    // Half a row on, the first row's bottom edge is past it too.
    sampleAt(letGoPx + rowHeightPx * 1.5, 1_032);

    expect(publishedRowKeys()[0]).not.toBe(headRowKey);
  });
});
