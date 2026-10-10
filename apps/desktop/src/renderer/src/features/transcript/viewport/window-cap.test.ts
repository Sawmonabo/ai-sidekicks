// The transcript window lets go on both sides of the reader, by the window's own height, and never
// takes the reader's row, a row on screen or a working row. Rows are one flat height, so where each
// cut falls is arithmetic a case can state.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_RETAINED_SCREEN_HEIGHTS } from "./caps.js";
import { TranscriptWindow, type PruneConditions, type WindowRow } from "./window-cap.js";

/** Every row's height, and the viewport's: four rows to a screen. */
const ROW_HEIGHT_PX = 100;
const VIEWPORT_HEIGHT_PX = 400;
/** Rows the retained share holds on each side of the viewport. */
const RETAINED_ROWS = (TRANSCRIPT_RETAINED_SCREEN_HEIGHTS * VIEWPORT_HEIGHT_PX) / ROW_HEIGHT_PX;
/** A log long enough that both edges sit far past the let-go distance from its middle. */
const LOG_ROW_COUNT = 400;
/** The row at the top of the reader's viewport, in the middle of the log. */
const READER_ROW_INDEX = 200;

function rowKey(index: number): string {
  return `row-${String(index)}`;
}

/** The log, every row top-level except those `parentKeyAt` hangs from a run group. */
function flatLog(
  parentKeyAt: (index: number) => string | undefined = () => undefined,
): readonly WindowRow[] {
  return Array.from({ length: LOG_ROW_COUNT }, (_unused, index) => ({
    key: rowKey(index),
    parentKey: parentKeyAt(index),
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** A reader at the top of their row in the middle of the log, with nothing refusing a cut. */
const READING_MID_LOG: PruneConditions = {
  scrollControllerVetoes: false,
  isWorkingRow: () => false,
  heldRowKeys: [],
  onScreenRowKeys: [],
  readingPosition: { rowKey: rowKey(READER_ROW_INDEX), offsetWithinViewportPx: 0 },
  viewportHeightPx: VIEWPORT_HEIGHT_PX,
  heightOf: () => ROW_HEIGHT_PX,
  admitSide: undefined,
};

function windowOverLog(): TranscriptWindow {
  const window = new TranscriptWindow();
  window.ingest(flatLog());
  return window;
}

function heldKeys(window: TranscriptWindow): readonly string[] {
  return window.rows().map((row) => row.key);
}

describe("the transcript window — letting go around the reader", () => {
  it("lets go of the rows past the retained share above and below the reader", () => {
    const window = windowOverLog();

    const outcome = window.prune(READING_MID_LOG);

    // Above: the rows within the share of the viewport's top edge. Below: the screen itself,
    // then the share past its bottom edge.
    const firstKept = READER_ROW_INDEX - RETAINED_ROWS;
    const lastKept = READER_ROW_INDEX + VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX + RETAINED_ROWS - 1;
    expect(heldKeys(window)[0]).toBe(rowKey(firstKept));
    expect(heldKeys(window).at(-1)).toBe(rowKey(lastKept));
    expect(outcome.applied).toBe(true);
    expect(outcome.owedBecause).toBeUndefined();
    expect(outcome.prunedKeys).toHaveLength(LOG_ROW_COUNT - (lastKept - firstKept + 1));
  });

  it("stops each cut short of a row on screen and of the reader's row, and names them", () => {
    // Heights that disagree with the screen (a row the library still lays out where the reader
    // was, a row taller than its estimate) put such rows past the line; the cut stops there.
    const window = windowOverLog();
    const onScreenRowIndex = 20;
    const readerRowIndex = READER_ROW_INDEX;

    const outcome = window.prune({
      ...READING_MID_LOG,
      onScreenRowKeys: [rowKey(onScreenRowIndex)],
      // The reader's row starts far below the top of the viewport, so it sits past the line below.
      readingPosition: { rowKey: rowKey(readerRowIndex), offsetWithinViewportPx: 5000 },
    });

    expect(heldKeys(window)[0]).toBe(rowKey(onScreenRowIndex));
    expect(heldKeys(window).at(-1)).toBe(rowKey(readerRowIndex));
    expect(outcome.prunedKeys).not.toContain(rowKey(onScreenRowIndex));
    expect(outcome.prunedKeys).not.toContain(rowKey(readerRowIndex));
    expect(outcome.owedBecause).toBe("on-screen-rows");

    // With nothing it may take, the pass is refused rather than reported as applied.
    const refused = window.prune({
      ...READING_MID_LOG,
      onScreenRowKeys: [rowKey(onScreenRowIndex)],
      readingPosition: { rowKey: rowKey(readerRowIndex), offsetWithinViewportPx: 5000 },
    });
    expect(refused.applied).toBe(false);
    expect(refused.deferredBecause).toBe("on-screen-rows");
    expect(heldKeys(window)[0]).toBe(rowKey(onScreenRowIndex));
    expect(heldKeys(window).at(-1)).toBe(rowKey(readerRowIndex));
  });

  it("stops a cut at a working row far from the reader, keeping its run group whole", () => {
    // A live run's header and rows sit far below the reader. While one of its rows still works,
    // the cut stops at that row and keeps the group whole, header included.
    const liveRunGroupKey = "run-live";
    const liveRowIndexes = Array.from({ length: 9 }, (_unused, offset) => 301 + offset);
    const liveLog = flatLog((index) =>
      liveRowIndexes.includes(index) ? liveRunGroupKey : undefined,
    ).map((row, index) => (index === 300 ? { ...row, key: liveRunGroupKey } : row));
    const liveGroupKeys = [liveRunGroupKey, ...liveRowIndexes.map(rowKey)];
    const workingRowKey = rowKey(305);
    const workingWindow = new TranscriptWindow();
    workingWindow.ingest(liveLog);

    const working = workingWindow.prune({
      ...READING_MID_LOG,
      isWorkingRow: (key) => key === workingRowKey,
    });

    expect(heldKeys(workingWindow)).toStrictEqual(expect.arrayContaining(liveGroupKeys));
    expect(heldKeys(workingWindow).at(-1)).toBe(rowKey(309));
    expect(working.prunedKeys).toContain(rowKey(399));
    expect(working.owedBecause).toBe("working-rows");
  });
});
