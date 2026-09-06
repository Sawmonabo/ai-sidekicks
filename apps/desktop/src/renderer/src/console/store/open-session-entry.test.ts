// One open session's three parts, driven directly.
//
// Almost everything an entry does is reached through `SessionStoreRegistry` and is
// asserted there, against the real registry — the repair loop the drain closes
// included. What is asserted HERE is the one claim the registry test structurally
// cannot make: that `dispose()` is terminal on BOTH children. `registry.close()`
// disposes an entry and then forgets it, so there is no handle left to ask whether
// a later delivery or a later refresh request re-arms a timer behind the pane that
// went away — and "a timer that outlives its pane" is the failure this binding
// exists to make unrepresentable.
//
// AND THE RESUME POSITION, for the same structural reason. The registry forwards the
// DECISION and not what the reader was handed, so a suite driving the registry can
// only ask what the entry decided — which is the reading that stayed green for the
// whole time the console decided a position and submitted it nowhere. Driving the
// entry directly is what lets the reader RECORD its third argument, and that record
// is the only assertion the defect could not have passed.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { eventOfKind } from "./session-event.test-support.js";
import { OpenSessionEntry } from "./open-session-entry.js";
import { RESUME_CURSOR_UNRESOLVABLE_CODE } from "./timeline-resume.js";
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

    // Neither child re-arms, and the dropped delivery is counted rather than
    // silently ignored: a subscription still feeding a closed session is a leak
    // one layer up, and the count is how it becomes visible.
    expect(clock.pendingCount).toBe(0);
    expect(entry.applyQueue.droppedAfterDisposeCount).toBe(2);
    expect(entry.refreshScheduler.isArmed).toBe(false);
    expect(entry.refreshScheduler.pendingReasons).toStrictEqual([]);
  });

  it("negative control: the same two calls before dispose DO arm both children", () => {
    // Without this, an entry whose queue and scheduler had stopped arming at all
    // would pass the case above by doing nothing in either state.
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
   * An entry whose successive reads follow a script, recording what each was handed.
   *
   * The RECORD is the assertion this suite exists to make. The decision was computed,
   * kept, and forwarded long before it was submitted anywhere, so an assertion that
   * only read the decision back off the entry passed for the whole time the console
   * was deciding a position and opening the stream wherever it opened before. What the
   * reader was HANDED is the only reading that cannot pass in that state.
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
      participantJoinLog: [],
      timelineCursors: {
        latest: "9_1723291500000000000",
        ...(acknowledged === undefined ? {} : { acknowledged }),
      },
    };
  }

  /** The rejection a daemon raises for a position it cannot resolve. */
  const CURSOR_REFUSAL = {
    rejectWith: {
      code: RESUME_CURSOR_UNRESOLVABLE_CODE,
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

    // Two reads, and the second one starts where the first was acknowledged. This is
    // the whole of the defect: the second entry here used to be `undefined`.
    expect(reads).toStrictEqual([
      { resumeFromCursor: undefined },
      { resumeFromCursor: "7_1723291480000000000" },
    ]);
    expect(entry.timelineResume?.outcome).toBe("resume");
  });

  it("negative control: a read that acknowledges nothing leaves the next read at the start", async () => {
    // Without this, an entry that submitted some remembered value unconditionally
    // would satisfy the case above — and would send a position on a session where
    // nothing has been acknowledged, which is a cursor the daemon has to refuse.
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

    // Three reads: the first, the one that carried the refused position, and the
    // recovery that carried none. The recovery goes through the SAME reader, so no
    // second read path exists to get out of step with this one.
    expect(reads).toStrictEqual([
      { resumeFromCursor: undefined },
      { resumeFromCursor: "7_1723291480000000000" },
      { resumeFromCursor: undefined },
    ]);
    // The refusal STANDS as the decision — a recovery that overwrote it would leave
    // the surface with nothing to say about a position it silently gave up.
    expect(entry.timelineResume?.outcome).toBe("refused");
    // And the store keeps its projection: the recovery answered at the beginning of
    // the window, which `admitsSnapshotAt` refuses for arriving behind the cursor.
    // Which is exactly why the settlement is REPORTED rather than left to ride a
    // store transition that does not happen.
    expect(entry.store.snapshot().cursor).toBe(7);
    expect(settlements.length).toBeGreaterThanOrEqual(2);
  });

  it("never submits a refused position twice", async () => {
    // The loop this closes: refuse, recover, be acknowledged at the same unresolvable
    // position, submit it again — two reads on every refresh for as long as it stood.
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
    // The other half of the classification. A read that failed is not a position that
    // was refused: it takes the scheduler's own error arm, which marks the store
    // degraded, and it takes no second read.
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
    // `event.cursor_unresolvable` refuses a request that carried a cursor, so it
    // cannot be about a position this read did not send. Taking it as ours would
    // report a lost place on a first read and re-read the window for nothing.
    const clock = new ManualClock(0);
    const { entry, reads } = entryReadingInTurn(clock, [CURSOR_REFUSAL, snapshotAt(0)]);

    await refresh(clock, entry);

    expect(reads).toStrictEqual([{ resumeFromCursor: undefined }]);
    expect(entry.timelineResume).toBeUndefined();
    expect(entry.store.snapshot().degradedCause).toBe("read-failed");
  });
});
