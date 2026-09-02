// The apply queue, driven on frozen time.
//
// Every assertion here is about a claim `Spec-023 §Console Design (Meridian)`
// §The eight rules makes and that a happy-path test cannot see: a burst costs one
// drain, a disposed pane arms nothing, and a drain that throws loses no event and
// takes no other session's callback down with it.
//
// It runs on `ManualClock` and arms no real timer at all. That is not a convenience:
// `clock.pendingCount === 0` after settle is the only way the idle-CPU budget's
// "no timer fires" claim can be CHECKED rather than asserted, and a test on real
// timers could not make it.
//
// `RefreshScheduler`, the module's other half, is driven by
// `scheduling.refresh-scheduler.test.ts`.

import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS, ManualClock } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { ApplyQueue } from "./scheduling.js";

function eventAt(sequence: number): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
  };
}

describe("ApplyQueue — a frame's worth of events is one drain", () => {
  it("coalesces a burst into one drain on one frame, with no time advanced", () => {
    const clock = new ManualClock(0);
    const drains: (readonly ConsoleSessionEvent[])[] = [];
    const queue = new ApplyQueue({
      clock,
      drain: (events) => {
        drains.push(events);
      },
      // `0` means the coalescing unit is a PAINT, which on the manual clock is an
      // explicit `runFrame()` — the frozen-clock arm, where no millisecond passes.
      coalesceMs: 0,
    });

    queue.enqueue(eventAt(1));
    queue.enqueue(eventAt(2));
    queue.enqueue(eventAt(3));

    // Three events, ONE armed frame. Three arms would be three renders.
    expect(queue.pendingCount).toBe(3);
    expect(clock.pendingFrameCount).toBe(1);
    expect(drains).toHaveLength(0);

    clock.runFrame();

    expect(drains).toHaveLength(1);
    expect(drains[0]?.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
    expect(queue.drainCount).toBe(1);
    // Nothing armed once it has settled: the idle-CPU precondition.
    expect(clock.pendingCount).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("negative control: a second frame's events are a SECOND drain", () => {
    // Without this, a `drain` that had stopped being called at all — or a
    // `drainCount` stuck at one — would pass the coalescing case above while the
    // queue delivered nothing after the first frame.
    const clock = new ManualClock(0);
    const drains: (readonly ConsoleSessionEvent[])[] = [];
    const queue = new ApplyQueue({
      clock,
      drain: (events) => {
        drains.push(events);
      },
      coalesceMs: 0,
    });

    queue.enqueue(eventAt(1));
    clock.runFrame();
    queue.enqueue(eventAt(2));
    clock.runFrame();

    expect(drains.map((batch) => batch.length)).toStrictEqual([1, 1]);
    expect(queue.drainCount).toBe(2);
  });

  it("uses the named coalescing window when the host has no paints", () => {
    const clock = new ManualClock(0);
    let drainCount = 0;
    const queue = new ApplyQueue({
      clock,
      drain: () => {
        drainCount += 1;
      },
    });

    queue.enqueue(eventAt(1));
    clock.advance(APPLY_COALESCE_MS - 1);
    expect(drainCount).toBe(0);
    clock.advance(1);
    expect(drainCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("drops and COUNTS events handed to a disposed queue rather than re-arming", () => {
    // A pane that unmounted mid-stream. Dropping is right — the store is gone —
    // but a subscription still delivering into it is a leak upstream, so the drop
    // is counted rather than silent, and no timer survives the dispose.
    const clock = new ManualClock(0);
    let drainCount = 0;
    const queue = new ApplyQueue({
      clock,
      drain: () => {
        drainCount += 1;
      },
      coalesceMs: 0,
    });

    queue.enqueue(eventAt(1));
    queue.dispose();
    expect(clock.pendingCount).toBe(0);

    queue.enqueue(eventAt(2));
    queue.enqueueAll([eventAt(3), eventAt(4)]);

    expect(queue.droppedAfterDisposeCount).toBe(3);
    expect(clock.pendingCount).toBe(0);
    clock.runFrame();
    expect(drainCount).toBe(0);
  });
});

describe("ApplyQueue — a drain that throws", () => {
  /** A drain that fails its first N calls and then succeeds. The defect models a
   *  projector rejecting a malformed payload, which is the only way the console's
   *  own drain can raise at all. */
  class FailingDrainRecorder {
    readonly drainedBatches: (readonly ConsoleSessionEvent[])[] = [];
    readonly failures: unknown[] = [];
    #remainingFailures: number;

    public constructor(failureCount: number) {
      this.#remainingFailures = failureCount;
    }

    public readonly drain = (events: readonly ConsoleSessionEvent[]): void => {
      if (this.#remainingFailures > 0) {
        this.#remainingFailures -= 1;
        throw new TypeError("the store refused this batch");
      }
      this.drainedBatches.push(events);
    };

    public readonly recordError = (error: unknown): void => {
      this.failures.push(error);
    };
  }

  it("keeps the batch, names the failure, and lets the clock finish its pass", () => {
    const clock = new ManualClock(0);
    const recorder = new FailingDrainRecorder(1);
    const queue = new ApplyQueue({
      clock,
      drain: recorder.drain,
      onDrainError: recorder.recordError,
      coalesceMs: 0,
    });
    let laterFrameRan = false;
    clock.scheduleFrame(() => {
      laterFrameRan = true;
    });

    queue.enqueueAll([eventAt(1), eventAt(2), eventAt(3)]);
    expect(() => {
      clock.runFrame();
    }).not.toThrow();

    // Nothing is lost: the three events are still queued, and the drain is not
    // counted as one that happened.
    expect(queue.pendingCount).toBe(3);
    expect(queue.drainCount).toBe(0);
    expect(queue.failedDrainCount).toBe(1);
    expect(recorder.failures).toHaveLength(1);
    expect(recorder.failures[0]).toBeInstanceOf(TypeError);
    // And the exception did not escape into the clock's own pass, where it would
    // have taken every other pending callback — every other session's drain — with
    // it. `runFrame` removes its entries before invoking them, so a throw there
    // does not merely defer the rest, it drops them.
    expect(laterFrameRan).toBe(true);
  });

  it("drains the retained batch ahead of what arrived after it, on the next window", () => {
    const clock = new ManualClock(0);
    const recorder = new FailingDrainRecorder(1);
    const queue = new ApplyQueue({
      clock,
      drain: recorder.drain,
      onDrainError: recorder.recordError,
      coalesceMs: 0,
    });

    queue.enqueueAll([eventAt(1), eventAt(2)]);
    clock.runFrame();
    queue.enqueue(eventAt(3));
    clock.runFrame();

    expect(recorder.drainedBatches).toHaveLength(1);
    // The retained events lead: they are older than what arrived while the failed
    // drain was running, and the store's own sequencing reads a batch in order.
    expect(recorder.drainedBatches[0]?.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
    expect(queue.pendingCount).toBe(0);
    expect(queue.drainCount).toBe(1);
  });

  it("does not re-arm on the failure itself, so a drain that always throws cannot spin", () => {
    const clock = new ManualClock(0);
    const recorder = new FailingDrainRecorder(Number.POSITIVE_INFINITY);
    const queue = new ApplyQueue({
      clock,
      drain: recorder.drain,
      onDrainError: recorder.recordError,
      coalesceMs: 0,
    });

    queue.enqueue(eventAt(1));
    clock.runFrame();

    // One failure, and nothing armed to produce a second on its own. The retry
    // rides the next enqueue rather than a timer the queue re-arms for itself.
    expect(queue.failedDrainCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("swallows nothing when no error sink is supplied — it still keeps the batch", () => {
    const clock = new ManualClock(0);
    const recorder = new FailingDrainRecorder(1);
    const queue = new ApplyQueue({ clock, drain: recorder.drain, coalesceMs: 0 });

    queue.enqueue(eventAt(1));
    expect(() => {
      clock.runFrame();
    }).not.toThrow();

    expect(queue.failedDrainCount).toBe(1);
    expect(queue.pendingCount).toBe(1);
  });

  it("negative control: a clean batch drains and counts as before", () => {
    // Without this, a `flush` that had stopped calling its drain at all would pass
    // every case above — nothing lost, nothing thrown, and nothing delivered.
    const clock = new ManualClock(0);
    const recorder = new FailingDrainRecorder(0);
    const queue = new ApplyQueue({
      clock,
      drain: recorder.drain,
      onDrainError: recorder.recordError,
      coalesceMs: 0,
    });

    queue.enqueueAll([eventAt(1), eventAt(2)]);
    clock.runFrame();

    expect(recorder.drainedBatches[0]?.map((event) => event.sequence)).toStrictEqual([1, 2]);
    expect(queue.drainCount).toBe(1);
    expect(queue.failedDrainCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
    expect(recorder.failures).toHaveLength(0);
  });
});
