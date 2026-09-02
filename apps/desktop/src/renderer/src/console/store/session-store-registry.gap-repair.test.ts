// A lossy delivery arms exactly one repair.
//
// The claim the apply drain exists for. `applyBatch` answers with what the batch
// cost, the store goes degraded on a skipped sequence, and only a completed re-pull
// clears that — so the drain has to read the outcome and ask the refresh scheduler
// for a `gap-repull`. With the outcome discarded, the repair waited for an unrelated
// focus or reconnect; on a quiet session, forever.
//
// The repair rides the scheduler rather than a direct read precisely so a run of
// holes costs one authoritative read, which is why the coalescing case below is a
// claim about the repair and not about the scheduler.
//
// Frozen clock throughout. The lifecycle is `session-store-registry.test.ts`; the
// two schedulers are `session-store-registry.scheduling.test.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import type { RefreshReason } from "./scheduling.js";
import {
  emptySnapshot,
  eventAt,
  projectors,
  settleMicrotasks,
} from "./session-store-registry.test-support.js";
import { SessionStoreRegistry } from "./session-store-registry.js";

describe("SessionStoreRegistry — a lossy delivery arms exactly one repair", () => {
  it("schedules exactly one gap-repull when a delivered batch skips a sequence", async () => {
    // The claim the drain exists for. `applyBatch` answers with what the batch
    // cost, the store goes degraded on a skipped sequence, and only a completed
    // re-pull clears that. With the outcome discarded, the repair waited for an
    // unrelated focus or reconnect — on a quiet session, forever.
    const clock = new ManualClock(0);
    const readCalls: RefreshReason[][] = [];
    const registry = new SessionStoreRegistry({
      clock,
      projectors,
      applyCoalesceMs: 0,
      refreshDebounceMs: 20,
      read: (_sessionId, reasons) => {
        readCalls.push([...reasons]);
        // Answers AT the cursor the store already reached: the repair carries the
        // sequences the stream skipped, so its newest sequence is the store's own.
        return Promise.resolve(emptySnapshot(5));
      },
    });
    const store = registry.open("session-1");
    store.initialise(emptySnapshot(0));

    registry.enqueue("session-1", [eventAt(1, "run-1"), eventAt(5, "run-5")]);
    clock.runFrame();

    // The store knows it is short 2..4, and the drain has armed the one read that
    // can fill the hole — one timeout, not one per missing sequence.
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 4 }]);
    expect(clock.pendingCount).toBe(1);

    clock.advance(20);
    await settleMicrotasks();

    // Exactly `gap-repull`, and exactly one of them: the reason names what asked
    // for the read, and the count is the repair actually happening.
    expect(readCalls).toStrictEqual([["gap-repull"]]);
    expect(registry.refreshCountFor("session-1")).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
    registry.disposeAll();
  });

  it("negative control: a clean batch schedules no repair at all", () => {
    // Without this, a drain that asked for a re-pull on every batch would pass the
    // case above while turning an ordinary stream into a read storm.
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
    store.initialise(emptySnapshot(0));

    registry.enqueue("session-1", [eventAt(1, "run-1"), eventAt(2, "run-2"), eventAt(3, "run-3")]);
    clock.runFrame();

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(clock.pendingCount).toBe(0);

    clock.advance(20);

    expect(readCalls).toStrictEqual([]);
    expect(registry.refreshCountFor("session-1")).toBe(0);
    registry.disposeAll();
  });

  it("coalesces two lossy batches inside one debounce window into one repair", async () => {
    // A stream that is dropping deliveries drops several. The repair rides the
    // scheduler rather than a direct read precisely so a run of holes costs one
    // authoritative read, and the reasons that asked for it are all carried.
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
    store.initialise(emptySnapshot(0));

    registry.enqueue("session-1", [eventAt(1, "run-1"), eventAt(5, "run-5")]);
    clock.runFrame();
    // Still inside the 20 ms window when the second lossy batch lands.
    clock.advance(10);
    registry.enqueue("session-1", [eventAt(9, "run-9")]);
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
