// The two schedulers, driven on frozen time.
//
// Every assertion here is about a claim `Spec-023 §Console Design (Meridian)`
// §The eight rules makes and that a happy-path test cannot see: a burst costs one
// read, a continuous stream still gets one (the absolute deadline), two reads never
// overlap, the reasons a read is performed for are the ones callers gave, and
// nothing stays armed after a pane goes away.
//
// It runs on `ManualClock` and arms no real timer at all. That is not a convenience:
// `clock.pendingCount === 0` after settle is the only way the idle-CPU budget's
// "no timer fires" claim can be CHECKED rather than asserted, and a test on real
// timers could not make it.

import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS, ManualClock } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { ApplyQueue, RefreshScheduler, type RefreshReason } from "./scheduling.js";

function eventAt(sequence: number): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
  };
}

/** Let every queued continuation run. The schedulers settle across microtasks. */
async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
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

describe("RefreshScheduler — one read per burst, and one under a stream", () => {
  it("fires at the absolute deadline when requests never stop arriving", async () => {
    const clock = new ManualClock(0);
    const firedAt: number[] = [];
    const reasonsSeen: RefreshReason[][] = [];
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 120,
      maxWaitMs: 1000,
      perform: (reasons) => {
        firedAt.push(clock.now());
        reasonsSeen.push([...reasons]);
        return Promise.resolve();
      },
    });

    scheduler.request("subscribe");
    for (let step = 1; step <= 10; step += 1) {
      clock.advance(100);
      scheduler.request("terminal-event");
    }
    await settleMicrotasks();

    // One read, at exactly the absolute deadline measured from the FIRST request.
    // A bare trailing debounce would have been pushed out ten times and read never.
    expect(firedAt).toStrictEqual([1000]);
    expect(scheduler.performCount).toBe(1);
    // And it carries every reason that asked for it BEFORE it fired, in order —
    // the diagnostics read this, so a coalesced read must not lose why it
    // happened. Ten, not eleven: the deadline lands inside the tenth `advance`,
    // so the tenth request is made against a read already in flight…
    expect(reasonsSeen[0]?.[0]).toBe("subscribe");
    expect(reasonsSeen[0]).toHaveLength(10);
    // …and is therefore held for the NEXT read rather than dropped. A request
    // that arrived one instruction too late must still be honoured.
    expect(scheduler.pendingReasons).toStrictEqual(["terminal-event"]);
    expect(scheduler.isArmed).toBe(true);
  });

  it("negative control: without the absolute deadline the stream starves the read", () => {
    // Same script, same class, one option changed. This is what makes the case
    // above a claim about `maxWaitMs` rather than about the clock harness.
    const clock = new ManualClock(0);
    let performCount = 0;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 120,
      maxWaitMs: Number.POSITIVE_INFINITY,
      perform: () => {
        performCount += 1;
        return Promise.resolve();
      },
    });

    scheduler.request("subscribe");
    for (let step = 1; step <= 10; step += 1) {
      clock.advance(100);
      scheduler.request("terminal-event");
    }

    expect(performCount).toBe(0);
    expect(scheduler.isArmed).toBe(true);
  });

  it("serializes: a request made mid-flight becomes the NEXT read, with its own reason", async () => {
    const clock = new ManualClock(0);
    const batches: RefreshReason[][] = [];
    let releaseInFlightRead: (() => void) | undefined;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 10,
      maxWaitMs: 1000,
      perform: async (reasons) => {
        batches.push([...reasons]);
        await new Promise<void>((resolve) => {
          releaseInFlightRead = resolve;
        });
      },
    });

    scheduler.request("subscribe");
    clock.advance(10);
    expect(batches).toStrictEqual([["subscribe"]]);

    // Asked for while the first read is still outstanding. It must not run in
    // parallel, and it must not be re-labelled.
    scheduler.request("gap-repull");
    expect(batches).toHaveLength(1);

    releaseInFlightRead?.();
    await settleMicrotasks();
    clock.advance(10);
    await settleMicrotasks();

    // Exactly `gap-repull`. An earlier shape re-armed by calling
    // `request("reconnect")`, which invented a diagnostics reason for a read
    // nobody asked for under that name.
    expect(batches[1]).toStrictEqual(["gap-repull"]);
    expect(scheduler.performCount).toBe(2);
  });

  it("surfaces a failed read through onError instead of swallowing it", async () => {
    const clock = new ManualClock(0);
    const failures: unknown[] = [];
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 10,
      perform: () => Promise.reject(new Error("the read did not land")),
      onError: (error) => {
        failures.push(error);
      },
    });

    scheduler.request("reconnect");
    clock.advance(10);
    await settleMicrotasks();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });

  it("arms nothing after dispose, even when a read was in flight", async () => {
    const clock = new ManualClock(0);
    let releaseInFlightRead: (() => void) | undefined;
    let performCount = 0;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 10,
      perform: async () => {
        performCount += 1;
        await new Promise<void>((resolve) => {
          releaseInFlightRead = resolve;
        });
      },
    });

    scheduler.request("subscribe");
    clock.advance(10);
    scheduler.request("window-focus");
    scheduler.dispose();
    releaseInFlightRead?.();
    await settleMicrotasks();

    // The pane is gone: the in-flight read's own `finally` must not re-arm a timer
    // behind it, and a later request must not start one either.
    expect(clock.pendingCount).toBe(0);
    scheduler.request("terminal-event");
    expect(clock.pendingCount).toBe(0);
    expect(scheduler.pendingReasons).toStrictEqual([]);
    expect(performCount).toBe(1);
  });
});
