// The refresh scheduler on frozen time: a continuous stream still gets a read, a request made
// mid-flight runs as the next read, each read runs inside a round the next one supersedes, and
// nothing stays armed after dispose. `ManualClock.pendingCount` is how "no timer left armed" is
// checked, which real timers cannot.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../clock.js";
import type { ReadRound } from "../read-scope.js";
import { RefreshScheduler, type RefreshReason } from "./refresh-scheduler.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

/** A local debounce: the round is under test, not the shipped interval. */
const TEST_DEBOUNCE_MS = 120;

/** A scheduler built with only the members every caller already passes. */
function schedulerRecordingRounds(clock: ManualClock, rounds: ReadRound[]): RefreshScheduler {
  return new RefreshScheduler({
    clock,
    debounceMs: TEST_DEBOUNCE_MS,
    perform: (_reasons, round) => {
      rounds.push(round);
      return Promise.resolve();
    },
  });
}

/** Advance past the debounce and let the fire's own microtasks settle. */
async function runOneRead(clock: ManualClock): Promise<void> {
  clock.advance(TEST_DEBOUNCE_MS);
  await crossMacrotaskBoundary();
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
    await crossMacrotaskBoundary();

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

  it("runs a request made mid-flight as the next read, with its own reason", async () => {
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
    await crossMacrotaskBoundary();
    clock.advance(10);
    await crossMacrotaskBoundary();

    // Exactly `gap-repull`: the re-arm invents no reason of its own.
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
    await crossMacrotaskBoundary();

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
    await crossMacrotaskBoundary();

    // After dispose, neither the in-flight read's `finally` nor a later request may arm a timer.
    expect(clock.pendingCount).toBe(0);
    scheduler.request("terminal-event");
    expect(clock.pendingCount).toBe(0);
    expect(scheduler.pendingReasons).toStrictEqual([]);
    expect(performCount).toBe(1);
  });
});

// Supersession a caller cannot decline: a scheduler built with only the usual members still hands
// its performer a round, so no read is unsupersedable and unabandonable.
describe("RefreshScheduler — every read runs inside a round", () => {
  it("supersedes the previous read's round when the next read fires", async () => {
    const clock = new ManualClock(0);
    const rounds: ReadRound[] = [];
    const scheduler = schedulerRecordingRounds(clock, rounds);

    scheduler.request("subscribe");
    await runOneRead(clock);
    scheduler.request("window-focus");
    await runOneRead(clock);

    expect(rounds).toHaveLength(2);
    const [first, second] = rounds;
    expect(first?.isCurrent).toBe(false);
    expect(first?.settle(() => undefined)).toBe(false);
    expect(second?.isCurrent).toBe(true);
    expect(second?.settle(() => undefined)).toBe(true);

    scheduler.dispose();
  });

  it("abandons the read in flight when the scheduler is disposed", async () => {
    const clock = new ManualClock(0);
    const rounds: ReadRound[] = [];
    let releaseRead: () => void = () => undefined;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: TEST_DEBOUNCE_MS,
      perform: async (_reasons, round) => {
        rounds.push(round);
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      },
    });

    scheduler.request("subscribe");
    await runOneRead(clock);

    const inFlight = rounds[0];
    // Control: the round is live before `dispose()`, so the assertion after is about disposal.
    expect(inFlight?.signal.aborted).toBe(false);

    scheduler.dispose();

    expect(inFlight?.signal.aborted).toBe(true);
    expect(inFlight?.isCurrent).toBe(false);

    releaseRead();
    await crossMacrotaskBoundary();
    expect(clock.pendingCount).toBe(0);
  });
});
