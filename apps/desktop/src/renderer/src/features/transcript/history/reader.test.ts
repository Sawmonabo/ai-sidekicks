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

/** A reader over the paged store and its log, whose queued tasks run when the case runs them. */
function openReader(): {
  readonly reader: TranscriptHistoryReader;
  readonly log: ReturnType<typeof scriptedTranscriptLog>;
  readonly clock: ManualClock;
  readonly runQueuedTasks: () => void;
  readonly heldRowCount: () => number;
} {
  const sessionStore = openPagedSessionStore(FIRST_HELD_INDEX, LOG_ROW_COUNT - 1, {
    cursor: transcriptFixtureStreamCursor(FIRST_HELD_INDEX - 1),
    hasMore: true,
  });
  const clock = new ManualClock();
  const queuedTasks: (() => void)[] = [];
  const reader = new TranscriptHistoryReader(sessionStore, clock, (task) => {
    queuedTasks.push(task);
  });
  const measure: TranscriptStretchMeasure = {
    screenHeightPx: () => OWED_HEIGHT_PX,
    smallestRowHeightPx: () => SMALLEST_ROW_ESTIMATE_PX,
    heldHeightPx: (transcript) => transcript.length * ROW_HEIGHT_PX,
  };
  reader.measureWith(measure);
  return {
    reader,
    log: scriptedTranscriptLog(LOG_ROW_COUNT),
    clock,
    runQueuedTasks: () => {
      for (const task of queuedTasks.splice(0)) {
        task();
      }
    },
    heldRowCount: () => sessionStore.snapshot().transcript.length,
  };
}

describe("TranscriptHistoryReader", () => {
  it("reads a stretch in its own task, each page a frame after the last landed", async () => {
    const { reader, log, clock, runQueuedTasks, heldRowCount } = openReader();

    expect(reader.readStretch("head", log.read, OWED_HEIGHT_PX)).toBe(true);
    // Marked under way at once, so a second ask before the task runs starts no second read.
    expect(reader.readStretch("head", log.read, OWED_HEIGHT_PX)).toBe(true);
    expect(reader.state().earlier.isReading).toBe(true);
    await letReadsLand();
    expect(log.requests.length).toBe(0);
    runQueuedTasks();
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

  it("gives way to a jump to an end of the log asked before the stretch's task ran", async () => {
    const { reader, log, runQueuedTasks } = openReader();
    let hasPageLanded = false;

    expect(reader.readStretch("head", log.read, OWED_HEIGHT_PX)).toBe(true);
    expect(
      reader.jumpTo("head", log.read, () => {
        hasPageLanded = true;
      }),
    ).toBe(true);
    runQueuedTasks();
    await letReadsLand();
    // The jump's read alone was sent, and its page took the window's place.
    expect({ asked: log.requests.length, hasPageLanded }).toEqual({
      asked: 1,
      hasPageLanded: true,
    });
  });

  it("offers a failed read inside the window again on the catch-up line", async () => {
    // The whole log held but rows 11 to 49, which a run's window left out.
    const sessionStore = openPagedSessionStore(0, LOG_ROW_COUNT - 1);
    sessionStore.releaseOutside(
      transcriptFixtureStreamCursor(0),
      transcriptFixtureStreamCursor(LOG_ROW_COUNT - 1),
      [
        {
          lastHeldCursorBefore: transcriptFixtureStreamCursor(10),
          firstHeldCursorAfter: transcriptFixtureStreamCursor(50),
        },
      ],
    );
    const queuedTasks: (() => void)[] = [];
    const reader = new TranscriptHistoryReader(sessionStore, new ManualClock(), (task) => {
      queuedTasks.push(task);
    });
    reader.measureWith({
      screenHeightPx: () => OWED_HEIGHT_PX,
      smallestRowHeightPx: () => SMALLEST_ROW_ESTIMATE_PX,
      heldHeightPx: (transcript) => transcript.length * ROW_HEIGHT_PX,
    });
    const log = scriptedTranscriptLog(LOG_ROW_COUNT);
    const runQueuedTasks = async () => {
      for (const task of queuedTasks.splice(0)) {
        task();
      }
      await letReadsLand();
    };
    const failedReads = () => sessionStore.failedDependentReads.readable.getState().failedReads;
    const [stretch] = sessionStore.snapshot().releasedStretches;

    log.refuseNextRead();
    expect(reader.readReleasedStretch(stretch!, "backward", log.read)).toBe(true);
    await runQueuedTasks();
    expect(failedReads()).toHaveLength(1);
    expect(reader.state().inside).toMatchObject({ isReading: false, hasFailed: true });

    sessionStore.failedDependentReads.retryFailed();
    await runQueuedTasks();
    expect(log.requests).toHaveLength(2);
    expect(failedReads()).toEqual([]);
    // The page landed nearest the window, so the stretch still let go ends lower.
    const [shrunk, ...others] = sessionStore.snapshot().releasedStretches;
    expect(others).toEqual([]);
    expect(shrunk?.lastHeldSequenceBefore).toBe(10);
    expect(shrunk?.firstHeldCursorAfter).not.toBe(stretch?.firstHeldCursorAfter);
  });
});
