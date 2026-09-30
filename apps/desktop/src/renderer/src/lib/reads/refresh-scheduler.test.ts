// The refresh scheduler on frozen time: a burst costs one read, a continuous stream still gets
// one, reads never overlap, reasons are the callers', and nothing stays armed after dispose.
// `ManualClock.pendingCount` is how "no timer left armed" is checked, which real timers cannot.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../clock.js";
import { RefreshScheduler, type RefreshReason } from "./refresh-scheduler.js";
import { settleMicrotasks } from "@test/helpers/session-store-fixtures.js";

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

    // One read, at the absolute deadline counted from the first request; a bare debounce would
    // have been pushed out ten times.
    expect(firedAt).toStrictEqual([1000]);
    expect(scheduler.performCount).toBe(1);
    // The read carries every reason requested before it fired, in order; diagnostics read them.
    // Ten, not eleven: the deadline lands inside the tenth `advance`, so the last request is
    // made against a read already in flight...
    expect(reasonsSeen[0]?.[0]).toBe("subscribe");
    expect(reasonsSeen[0]).toHaveLength(10);
    // ...and is held for the next read rather than dropped.
    expect(scheduler.pendingReasons).toStrictEqual(["terminal-event"]);
    expect(scheduler.isArmed).toBe(true);
  });

  it("negative control: without the absolute deadline the stream starves the read", () => {
    // Same script with one option changed, so the case above is about `maxWaitMs`, not the
    // clock harness.
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

    // Asked for while the first read is outstanding: it must not run in parallel or be
    // re-labeled.
    scheduler.request("gap-repull");
    expect(batches).toHaveLength(1);

    releaseInFlightRead?.();
    await settleMicrotasks();
    clock.advance(10);
    await settleMicrotasks();

    // Exactly `gap-repull`: the re-arm invents no reason of its own.
    expect(batches[1]).toStrictEqual(["gap-repull"]);
    expect(scheduler.performCount).toBe(2);
  });

  it("runs a mid-flight request at completion when its max-wait already elapsed", async () => {
    // The absolute deadline counts from the request, not the timer: a repair queued behind an
    // over-long read must not wait a further debounce past a deadline it is already overdue on.
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

    // Queued at 120 against a 1000 ms max-wait, so due at 1120; the read ahead of it finishes
    // at exactly 1120.
    scheduler.request("gap-repull");
    clock.advance(1000);
    releaseInFlightRead?.();
    await settleMicrotasks();

    // Overdue at the re-arm, so the delay floors at zero and the read runs on the completion
    // tick rather than at 1240.
    clock.advance(0);
    expect(firedAt).toStrictEqual([120, 1120]);
    expect(scheduler.performCount).toBe(2);
  });

  it("negative control: a mid-flight request well inside the window still debounces", async () => {
    // Same script with a short read; a scheduler that fired every re-arm at zero delay would
    // pass the case above while coalescing nothing.
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

    // The absolute deadline is 1120 but the debounce (130 + 120) binds, so nothing runs on the
    // completion tick.
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

    // After dispose, neither the in-flight read's `finally` nor a later request may arm a timer.
    expect(clock.pendingCount).toBe(0);
    scheduler.request("terminal-event");
    expect(clock.pendingCount).toBe(0);
    expect(scheduler.pendingReasons).toStrictEqual([]);
    expect(performCount).toBe(1);
  });
});

describe("the user's own reason — a press, recorded as a press", () => {
  it("carries it to the read verbatim, beside the reasons the system gave", async () => {
    const clock = new ManualClock(0);
    const reasonsSeen: RefreshReason[][] = [];
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 10,
      perform: (reasons) => {
        reasonsSeen.push([...reasons]);
        return Promise.resolve();
      },
    });

    scheduler.request("subscribe");
    scheduler.request("user-request");
    clock.advance(10);
    await settleMicrotasks();

    // Both reasons, in request order; the press is not folded into the subscription beside it.
    expect(reasonsSeen).toStrictEqual([["subscribe", "user-request"]]);
  });

  it("coalesces like every other reason rather than jumping the queue", async () => {
    const clock = new ManualClock(0);
    let performCount = 0;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: 10,
      perform: () => {
        performCount += 1;
        return Promise.resolve();
      },
    });

    scheduler.request("user-request");
    scheduler.request("user-request");
    scheduler.request("user-request");
    expect(performCount).toBe(0);
    clock.advance(10);
    await settleMicrotasks();

    // One read: a reason names why a read happened, not how urgent it was.
    expect(performCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: the union without it cannot hold the value", () => {
    /** The reason union without `user-request`. */
    type ReasonsBeforeThePress = "subscribe" | "window-focus" | "reconnect" | "terminal-event";
    const press: RefreshReason = "user-request";

    // @ts-expect-error — the union has no member for a user's press.
    const borrowed: ReasonsBeforeThePress = press;

    expect(String(borrowed)).toBe("user-request");
  });
});
