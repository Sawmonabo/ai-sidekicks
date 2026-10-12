// A batch drains on its frame, or once the fallback runs out in a window that draws none, and a
// drain that throws loses no event and takes no other session's callback down with it. It runs
// on `ManualClock`, whose frames run only when a case says so.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import type { ProjectedSessionEvent } from "../entities/vocabulary.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { APPLY_FRAME_FALLBACK_MS, ApplyQueue } from "./queue.js";

describe("ApplyQueue — when a batch drains", () => {
  it("drains on its frame, or without one once the fallback runs out, once either way", () => {
    const clock = new ManualClock(0);
    const drained: (readonly ProjectedSessionEvent[])[] = [];
    const queue = new ApplyQueue({
      clock,
      drain: (events) => {
        drained.push(events);
      },
    });

    // A window that draws frames drains on the first, and leaves no timer behind.
    queue.enqueue(eventOfKind("session-1", "run.starting", 1));
    clock.runFrame();
    expect(drained).toHaveLength(1);
    expect(clock.pendingCount).toBe(0);

    // One that draws none, as a hidden window may, drains when the fallback runs out.
    queue.enqueue(eventOfKind("session-1", "run.starting", 2));
    clock.advance(APPLY_FRAME_FALLBACK_MS - 1);
    expect(drained).toHaveLength(1);
    clock.advance(1);
    expect(drained).toHaveLength(2);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("ApplyQueue — a drain that throws", () => {
  /** A drain that fails its first N calls and then succeeds. */
  class FailingDrainRecorder {
    readonly drainedBatches: (readonly ProjectedSessionEvent[])[] = [];
    readonly failures: unknown[] = [];
    #remainingFailures: number;

    public readonly drain = (events: readonly ProjectedSessionEvent[]): void => {
      if (this.#remainingFailures > 0) {
        this.#remainingFailures -= 1;
        throw new TypeError("the store refused this batch");
      }
      this.drainedBatches.push(events);
    };

    public readonly recordError = (error: unknown): void => {
      this.failures.push(error);
    };

    public constructor(failureCount: number) {
      this.#remainingFailures = failureCount;
    }
  }

  it("keeps the batch, names the failure, and lets the clock finish its pass", () => {
    const clock = new ManualClock(0);
    const recorder = new FailingDrainRecorder(1);
    const queue = new ApplyQueue({
      clock,
      drain: recorder.drain,
      onDrainError: recorder.recordError,
    });
    let laterFrameRan = false;
    clock.scheduleFrame(() => {
      laterFrameRan = true;
    });

    queue.enqueueAll([
      eventOfKind("session-1", "run.starting", 1),
      eventOfKind("session-1", "run.starting", 2),
      eventOfKind("session-1", "run.starting", 3),
    ]);
    expect(() => {
      clock.runFrame();
    }).not.toThrow();

    // Nothing is lost: the events are still queued and the drain is not counted.
    expect(queue.pendingCount).toBe(3);
    expect(queue.drainCount).toBe(0);
    expect(queue.failedDrainCount).toBe(1);
    expect(recorder.failures).toHaveLength(1);
    expect(recorder.failures[0]).toBeInstanceOf(TypeError);
    // The exception did not escape into the clock's pass, where it would have dropped every
    // other session's drain (`runFrame` removes its entries before invoking them).
    expect(laterFrameRan).toBe(true);
  });
});
