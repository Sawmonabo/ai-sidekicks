// The refresh scheduler, driven on frozen time.
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
//
// `ApplyQueue`, the module's other half, is driven by `scheduling.test.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { RefreshScheduler, type RefreshReason } from "./scheduling.js";

/** Let every queued continuation run. The scheduler settles across microtasks. */
async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

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

  it("runs a mid-flight request at completion when its max-wait already elapsed", async () => {
    // The absolute deadline belongs to the REQUEST, not to the timer. A request
    // made while a slow read is outstanding is already waiting; it just has no
    // timer yet. Dating the deadline from the read's completion made a repair
    // queued behind an over-long read serve a further debounce interval past the
    // absolute deadline it was already overdue against.
    const clock = new ManualClock(0);
    const firedAt: number[] = [];
    let releaseInFlightRead: (() => void) | undefined;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 120,
      maxWaitMs: 1000,
      perform: async () => {
        firedAt.push(clock.now());
        await new Promise<void>((resolve) => {
          releaseInFlightRead = resolve;
        });
      },
    });

    scheduler.request("subscribe");
    clock.advance(120);
    expect(firedAt).toStrictEqual([120]);

    // Queued at 120 against a 1000 ms max-wait, so it is due at 1120 — and the
    // read it is queued behind does not finish until 1120 exactly.
    scheduler.request("gap-repull");
    clock.advance(1000);
    releaseInFlightRead?.();
    await settleMicrotasks();

    // Overdue on arrival at the re-arm, so the delay floors at zero and the read
    // runs on the completion tick rather than at 1240.
    clock.advance(0);
    expect(firedAt).toStrictEqual([120, 1120]);
    expect(scheduler.performCount).toBe(2);
  });

  it("negative control: a mid-flight request well inside the window still debounces", async () => {
    // Same script, a short read instead of an over-long one. Without this, a
    // scheduler that had stopped debouncing altogether — firing every re-arm at
    // zero delay — would pass the case above while coalescing nothing.
    const clock = new ManualClock(0);
    const firedAt: number[] = [];
    let releaseInFlightRead: (() => void) | undefined;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 120,
      maxWaitMs: 1000,
      perform: async () => {
        firedAt.push(clock.now());
        await new Promise<void>((resolve) => {
          releaseInFlightRead = resolve;
        });
      },
    });

    scheduler.request("subscribe");
    clock.advance(120);
    scheduler.request("gap-repull");
    clock.advance(10);
    releaseInFlightRead?.();
    await settleMicrotasks();

    // Due at 1120 and the read completed at 130: the debounce is the binding
    // deadline, so nothing runs on the completion tick.
    clock.advance(0);
    expect(firedAt).toStrictEqual([120]);
    clock.advance(120);
    expect(firedAt).toStrictEqual([120, 250]);
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
