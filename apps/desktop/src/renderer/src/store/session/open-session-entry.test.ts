// One open session's three parts, driven directly. Most of an entry's behavior is asserted
// through `SessionStoreRegistry`; two claims need the entry itself. First, `dispose()` is
// terminal on both children: `registry.close()` disposes then forgets the entry, so no handle
// remains to ask whether a later delivery or refresh re-arms a timer behind the gone pane.
// Second, the resume position is submitted on the read: the registry forwards only the decision,
// so recording the reader's third argument is the one assertion that fails if the console
// decides a position and submits it nowhere.

import { describe, expect, it } from "vitest";

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import { ManualClock } from "@renderer/lib/clock.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { OpenSessionEntry } from "./open-session-entry.js";
import type { SessionSnapshot } from "./session-store.js";

/** A reader that establishes nothing, so no read can clear what a test set up. */
const readsNothing = (): Promise<undefined> => Promise.resolve(undefined);

describe("OpenSessionEntry — dispose is terminal on both children", () => {
  it("arms nothing for a delivery or a refresh asked for after dispose", () => {
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-1", {
      read: readsNothing,
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });

    entry.dispose();
    entry.applyQueue.enqueueAll([
      eventOfKind("session-1", "run.starting", 1),
      eventOfKind("session-1", "run.starting", 2),
    ]);
    entry.refreshScheduler.request("window-focus");

    // Neither child re-arms, and the dropped delivery is counted (an upstream leak otherwise).
    expect(clock.pendingCount).toBe(0);
    expect(entry.applyQueue.droppedAfterDisposeCount).toBe(2);
    expect(entry.refreshScheduler.isArmed).toBe(false);
    expect(entry.refreshScheduler.pendingReasons).toStrictEqual([]);
  });

  it("negative control: the same two calls before dispose DO arm both children", () => {
    // Guards a queue and scheduler that stopped arming, which would pass the case above.
    const clock = new ManualClock(0);
    const entry = new OpenSessionEntry("session-1", {
      read: readsNothing,
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
    });

    entry.applyQueue.enqueueAll([
      eventOfKind("session-1", "run.starting", 1),
      eventOfKind("session-1", "run.starting", 2),
    ]);
    entry.refreshScheduler.request("window-focus");

    // One frame for the queue, one timeout for the scheduler.
    expect(clock.pendingFrameCount).toBe(1);
    expect(clock.pendingCount).toBe(2);
    expect(entry.applyQueue.droppedAfterDisposeCount).toBe(0);
    expect(entry.refreshScheduler.isArmed).toBe(true);

    entry.dispose();
    expect(clock.pendingCount).toBe(0);
  });
});

describe("OpenSessionEntry — the resume position is submitted on the read", () => {
  /** One read the entry performed: which position it was asked to start from. */
  interface RecordedRead {
    readonly resumeFromCursor: string | undefined;
  }

  /** What a scripted read does when the entry performs it. */
  type ScriptedRead = SessionSnapshot | { readonly rejectWith: unknown };

  /**
   * An entry whose successive reads follow a script, recording what each was handed. The record
   * is the assertion: reading the decision back off the entry would pass while the position is
   * decided but never submitted.
   */
  function entryReadingInTurn(
    clock: ManualClock,
    script: readonly ScriptedRead[],
    onTimelineResumeSettled?: () => void,
  ): { readonly entry: OpenSessionEntry; readonly reads: RecordedRead[] } {
    const reads: RecordedRead[] = [];
    let readIndex = 0;
    const entry = new OpenSessionEntry("session-1", {
      read: (_sessionId, _reasons, resumeFromCursor) => {
        reads.push({ resumeFromCursor });
        const step = script[Math.min(readIndex, script.length - 1)];
        readIndex += 1;
        if (step !== undefined && "rejectWith" in step) {
          return Promise.reject(step.rejectWith);
        }
        return Promise.resolve(step);
      },
      clock,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      ...(onTimelineResumeSettled === undefined ? {} : { onTimelineResumeSettled }),
    });
    return { entry, reads };
  }

  /** Ask for a refresh and let the scheduler's deadline and its promise settle. */
  async function refresh(clock: ManualClock, entry: OpenSessionEntry): Promise<void> {
    entry.refreshScheduler.request("window-focus");
    clock.advance(21);
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
  }

  /** A snapshot at `cursor`, acknowledged where one is supplied. */
  function snapshotAt(cursor: number, acknowledged?: string): SessionSnapshot {
    return {
      cursor,
      entities: [],
      timelineCursors: {
        latest: "9_1723291500000000000",
        ...(acknowledged === undefined ? {} : { acknowledged }),
      },
    };
  }

  /** The rejection a daemon raises for a position it cannot resolve. */
  const CURSOR_REFUSAL = {
    rejectWith: {
      code: EVENT_CURSOR_UNRESOLVABLE_CODE,
      message: "the submitted cursor could not be decoded",
    },
  };

  it("submits nothing on the first read and the acknowledged position on the next", async () => {
    const clock = new ManualClock(0);
    const { entry, reads } = entryReadingInTurn(clock, [
      snapshotAt(7, "7_1723291480000000000"),
      snapshotAt(9, "9_1723291500000000000"),
    ]);

    await refresh(clock, entry);
    await refresh(clock, entry);

    // The second read starts where the first was acknowledged.
    expect(reads).toStrictEqual([
      { resumeFromCursor: undefined },
      { resumeFromCursor: "7_1723291480000000000" },
    ]);
    expect(entry.timelineResume?.outcome).toBe("resume");
  });

  it("negative control: a read that acknowledges nothing leaves the next read at the start", async () => {
    // Guards an entry that submitted a remembered value unconditionally, sending a position
    // the daemon must refuse where nothing was acknowledged.
    const clock = new ManualClock(0);
    const { entry, reads } = entryReadingInTurn(clock, [snapshotAt(7), snapshotAt(9)]);

    await refresh(clock, entry);
    await refresh(clock, entry);

    expect(reads).toStrictEqual([{ resumeFromCursor: undefined }, { resumeFromCursor: undefined }]);
    expect(entry.timelineResume?.outcome).toBe("restart");
  });

  it("re-reads from the beginning and records the refusal when the position is refused", async () => {
    const clock = new ManualClock(0);
    const settlements: number[] = [];
    const { entry, reads } = entryReadingInTurn(
      clock,
      [snapshotAt(7, "7_1723291480000000000"), CURSOR_REFUSAL, snapshotAt(0)],
      () => settlements.push(1),
    );

    await refresh(clock, entry);
    await refresh(clock, entry);

    // Three reads: the first, the one carrying the refused position, and the recovery carrying
    // none. The recovery uses the same reader, so no second read path can drift.
    expect(reads).toStrictEqual([
      { resumeFromCursor: undefined },
      { resumeFromCursor: "7_1723291480000000000" },
      { resumeFromCursor: undefined },
    ]);
    // The refusal stands as the decision; overwriting it would hide a position given up.
    expect(entry.timelineResume?.outcome).toBe("refused");
    // The store keeps its projection: the recovery answered behind the cursor, which
    // `admitsSnapshotAt` refuses, so the settlement is reported rather than left to a store
    // transition that does not happen.
    expect(entry.store.snapshot().cursor).toBe(7);
    expect(settlements.length).toBeGreaterThanOrEqual(2);
  });

  it("never submits a refused position twice", async () => {
    // Closes the loop of refuse, recover, be acknowledged at the same position, submit again:
    // two reads per refresh.
    const clock = new ManualClock(0);
    const { entry, reads } = entryReadingInTurn(clock, [
      snapshotAt(7, "7_1723291480000000000"),
      CURSOR_REFUSAL,
      snapshotAt(0, "7_1723291480000000000"),
      snapshotAt(0, "7_1723291480000000000"),
    ]);

    await refresh(clock, entry);
    await refresh(clock, entry);
    await refresh(clock, entry);

    expect(reads.map((read) => read.resumeFromCursor)).toStrictEqual([
      undefined,
      "7_1723291480000000000",
      undefined,
      undefined,
    ]);
  });

  it("degrades the store rather than recovering when a read fails for any other reason", async () => {
    // A failed read is not a refused position: it takes the scheduler's error arm, which marks
    // the store degraded, and takes no second read.
    const clock = new ManualClock(0);
    const { entry, reads } = entryReadingInTurn(clock, [
      snapshotAt(7, "7_1723291480000000000"),
      { rejectWith: { code: "session.not_found", message: "no such session" } },
    ]);

    await refresh(clock, entry);
    await refresh(clock, entry);

    expect(reads.length).toBe(2);
    expect(entry.timelineResume?.outcome).toBe("resume");
    expect(entry.store.snapshot().degradedCause).toBe("read-failed");
  });

  it("does not claim a refused position when it submitted none", async () => {
    // The code refuses a request that carried a cursor, so it cannot be about a position this
    // read did not send; taking it as ours would report a lost place on a first read.
    const clock = new ManualClock(0);
    const { entry, reads } = entryReadingInTurn(clock, [CURSOR_REFUSAL, snapshotAt(0)]);

    await refresh(clock, entry);

    expect(reads).toStrictEqual([{ resumeFromCursor: undefined }]);
    expect(entry.timelineResume).toBeUndefined();
    expect(entry.store.snapshot().degradedCause).toBe("read-failed");
  });
});
