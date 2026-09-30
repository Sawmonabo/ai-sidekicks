// A lossy delivery arms exactly one repair. `applyBatch` reports what the batch cost, a skipped
// sequence degrades the store, and only a completed re-pull clears it, so the drain must ask the
// refresh scheduler for a `gap-repull`; discarding the outcome would leave a quiet session
// degraded forever. The repair rides the scheduler so a run of holes costs one read.
//
// Frozen clock throughout. The lifecycle is `session-store-registry.test.ts`; the two schedulers
// are `session-store-registry.scheduling.test.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import {
  emptySnapshot,
  runEventAt,
  projectors,
  settleMicrotasks,
} from "@test/helpers/session-store-fixtures.js";
import { SessionStoreRegistry } from "./session-store-registry.js";

describe("SessionStoreRegistry — a lossy delivery arms exactly one repair", () => {
  it("schedules exactly one gap-repull when a delivered batch skips a sequence", async () => {
    // With the outcome discarded, the repair would wait for an unrelated focus or reconnect.
    const clock = new ManualClock(0);
    const readCalls: RefreshReason[][] = [];
    const registry = new SessionStoreRegistry({
      clock,
      projectors,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      read: (_sessionId, reasons) => {
        readCalls.push([...reasons]);
        // Answers at the store's own cursor, since the repair carries the skipped sequences.
        return Promise.resolve(emptySnapshot(5));
      },
    });
    const store = registry.open("session-1");
    store.initialize(emptySnapshot(0));

    registry.enqueue("session-1", [runEventAt(1, "run-1"), runEventAt(5, "run-5")]);
    clock.runFrame();

    // The store is short 2..4 and the drain armed the one read that can fill it, once.
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 4 }]);
    expect(clock.pendingCount).toBe(1);

    clock.advance(20);
    await settleMicrotasks();

    // Exactly one `gap-repull`: the reason names what asked and the count is the repair.
    expect(readCalls).toStrictEqual([["gap-repull"]]);
    expect(registry.refreshCountFor("session-1")).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
    registry.disposeAll();
  });

  it("negative control: a clean batch schedules no repair at all", () => {
    // Guards a drain that re-pulled on every batch, turning an ordinary stream into a read storm.
    const clock = new ManualClock(0);
    const readCalls: RefreshReason[][] = [];
    const registry = new SessionStoreRegistry({
      clock,
      projectors,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      read: (_sessionId, reasons) => {
        readCalls.push([...reasons]);
        return Promise.resolve(emptySnapshot(3));
      },
    });
    const store = registry.open("session-1");
    store.initialize(emptySnapshot(0));

    registry.enqueue("session-1", [
      runEventAt(1, "run-1"),
      runEventAt(2, "run-2"),
      runEventAt(3, "run-3"),
    ]);
    clock.runFrame();

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(clock.pendingCount).toBe(0);

    clock.advance(20);

    expect(readCalls).toStrictEqual([]);
    expect(registry.refreshCountFor("session-1")).toBe(0);
    registry.disposeAll();
  });

  it("coalesces two lossy batches inside one debounce window into one repair", async () => {
    // A lossy stream drops several; the scheduler makes the holes one read carrying every reason.
    const clock = new ManualClock(0);
    const readCalls: RefreshReason[][] = [];
    const registry = new SessionStoreRegistry({
      clock,
      projectors,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      refreshMaxWaitMs: 1000,
      read: (_sessionId, reasons) => {
        readCalls.push([...reasons]);
        return Promise.resolve(emptySnapshot(9));
      },
    });
    const store = registry.open("session-1");
    store.initialize(emptySnapshot(0));

    registry.enqueue("session-1", [runEventAt(1, "run-1"), runEventAt(5, "run-5")]);
    clock.runFrame();
    // Still inside the 20 ms window when the second lossy batch lands.
    clock.advance(10);
    registry.enqueue("session-1", [runEventAt(9, "run-9")]);
    clock.runFrame();

    expect(store.snapshot().gaps).toStrictEqual([
      { fromSequence: 2, toSequence: 4 },
      { fromSequence: 6, toSequence: 8 },
    ]);

    clock.advance(20);
    await settleMicrotasks();

    // ONE read, carrying both requests' reasons in order.
    expect(readCalls).toStrictEqual([["gap-repull", "gap-repull"]]);
    expect(registry.refreshCountFor("session-1")).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(clock.pendingCount).toBe(0);
    registry.disposeAll();
  });
});
