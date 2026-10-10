import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import {
  openPagedSessionStore,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
} from "../logs.test-support.js";
import { TranscriptHistoryReader, type TranscriptStretchMeasure } from "./reader.js";

/** The log's length, and the rows the store opens with: the last ten. */
const LOG_ROW_COUNT = 100;
const FIRST_HELD_INDEX = 90;
/** Every row draws this tall, half the least a page's limit is sized for, so a page pays half. */
const ROW_HEIGHT_PX = 10;
const SMALLEST_ROW_ESTIMATE_PX = 20;
/** A stretch three pages pay: two rows, then one, then one. */
const OWED_HEIGHT_PX = 40;

/** Lets every page a served read answers land, as a task does once its microtasks run out. */
async function letReadsLand(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("TranscriptHistoryReader", () => {
  it("asks each page of a stretch a frame after the last landed", async () => {
    const sessionStore = openPagedSessionStore(FIRST_HELD_INDEX, LOG_ROW_COUNT - 1, {
      cursor: transcriptFixtureStreamCursor(FIRST_HELD_INDEX - 1),
      hasMore: true,
    });
    const log = scriptedTranscriptLog(LOG_ROW_COUNT);
    const clock = new ManualClock();
    const reader = new TranscriptHistoryReader(sessionStore, clock);
    const measure: TranscriptStretchMeasure = {
      screenHeightPx: () => OWED_HEIGHT_PX,
      smallestRowHeightPx: () => SMALLEST_ROW_ESTIMATE_PX,
      heldHeightPx: (transcript) => transcript.length * ROW_HEIGHT_PX,
    };
    reader.measureWith(measure);
    const heldRowCount = (): number => sessionStore.snapshot().transcript.length;

    expect(reader.readStretch("head", log.read, OWED_HEIGHT_PX)).toBe(true);
    await letReadsLand();
    expect({ asked: log.requests.length, held: heldRowCount() }).toEqual({ asked: 1, held: 12 });
    clock.runFrame();
    await letReadsLand();
    expect({ asked: log.requests.length, held: heldRowCount() }).toEqual({ asked: 2, held: 13 });
    clock.runFrame();
    await letReadsLand();
    expect({ asked: log.requests.length, held: heldRowCount() }).toEqual({ asked: 3, held: 14 });
    // Paid: the walk ends with no frame left armed and nothing more asked.
    expect(clock.pendingFrameCount).toBe(0);
    expect(reader.state().earlier.isReading).toBe(false);
  });
});
