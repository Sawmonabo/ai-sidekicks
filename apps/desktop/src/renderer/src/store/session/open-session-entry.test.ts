// The resume position is submitted on the read, and a position the daemon refuses is given up for
// a re-read from the window's beginning. The registry forwards only the decision, so recording
// the reader's third argument is the one assertion that fails if the console decides a position
// and submits it nowhere.

import { describe, expect, it } from "vitest";

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts";

import { ManualClock } from "@renderer/lib/clock.js";
import { OpenSessionEntry } from "./open-session-entry.js";
import type { SessionSnapshot } from "./session-store.js";

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
});
