// The per-session store lifecycle and its two schedulers. A second open of one session is the
// same store, a close forgets it, and a delivery for a session nobody has open refuses instead of
// throwing through the bridge's subscription. Applies go through the queue and reads through the
// scheduler, on a frozen clock: events reach the store frame by frame, a read establishes the
// store or marks it degraded, window focus reaches every open session, and a lossy delivery arms
// the one repair that can fill it.

import { describe, expect, it } from "vitest";

import { isRefusal } from "@renderer/lib/refusal.js";
import { ManualClock } from "@renderer/lib/clock.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import {
  emptyBaseState,
  runEventAt,
  projectors,
  readsNothing,
} from "@test/helpers/session-store-fixtures.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SESSION_REGISTRY_ORIGIN, SessionStoreRegistry } from "./session-store-registry.js";

describe("SessionStoreRegistry — one store per open session", () => {
  it("returns the SAME store for a second open of one session", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });

    const first = registry.open("session-1");
    const second = registry.open("session-1");
    const other = registry.open("session-2");

    // Two stores for one session would each hold half the stream.
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(registry.openCount).toBe(2);
    expect(registry.openSessionIds).toStrictEqual(["session-1", "session-2"]);
    registry.disposeAll();
  });

  it("forgets a closed session and opens a fresh store on re-open", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });

    const first = registry.open("session-1");
    expect(registry.close("session-1")).toBe(true);
    expect(registry.peek("session-1")).toBeUndefined();
    expect(registry.has("session-1")).toBe(false);
    // Idempotent: closing an already-closed session is not an error.
    expect(registry.close("session-1")).toBe(false);

    const reopened = registry.open("session-1");
    expect(reopened).not.toBe(first);
    registry.disposeAll();
  });

  it("refuses — rather than throws — for a session that is not open", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });

    const refusal = registry.enqueue("session-gone", [runEventAt(1, "run-1")]);

    expect(refusal).toBeDefined();
    expect(isRefusal(refusal)).toBe(true);
    expect(refusal?.origin).toBe(SESSION_REGISTRY_ORIGIN);
    expect(refusal?.code).toBe("session-not-open");
    expect(registry.requestRefresh("session-gone", "reconnect")?.code).toBe("session-not-open");
    expect(registry.flush("session-gone")?.code).toBe("session-not-open");
    expect(registry.markDegraded("session-gone", "subscription-closed")?.code).toBe(
      "session-not-open",
    );

    // Negative control: the same calls on an open session refuse nothing (openness, not method).
    registry.open("session-1");
    expect(registry.enqueue("session-1", [runEventAt(1, "run-1")])).toBeUndefined();
    expect(registry.requestRefresh("session-1", "reconnect")).toBeUndefined();
    expect(registry.flush("session-1")).toBeUndefined();
    expect(registry.markDegraded("session-1", "subscription-closed")).toBeUndefined();
    registry.disposeAll();
  });
});

describe("SessionStoreRegistry — applies go through the queue, reads through the scheduler", () => {
  it("coalesces a burst of events into one transition on one frame", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialize(emptyBaseState(0));
    const revisionBefore = store.snapshot().revision;

    registry.enqueue("session-1", [runEventAt(1, "run-1"), runEventAt(2, "run-2")]);
    registry.enqueue("session-1", [runEventAt(3, "run-3")]);

    // Nothing has reached the store yet: the queue holds the frame.
    expect(store.snapshot().revision).toBe(revisionBefore);
    expect(clock.pendingFrameCount).toBe(1);

    clock.runFrame();

    // Three events, one revision: four streaming lanes cost one render.
    expect(store.snapshot().revision).toBe(revisionBefore + 1);
    expect(registry.applyDrainCountFor("session-1")).toBe(1);
    expect(Object.keys(store.snapshot().partitions.run).sort()).toStrictEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
    expect(clock.pendingCount).toBe(0);
    registry.disposeAll();
  });

  it("applies a second frame's events as a second transition", () => {
    // A queue that stopped arming after its first frame would leave every later event undelivered.
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialize(emptyBaseState(0));
    const revisionBefore = store.snapshot().revision;

    registry.enqueue("session-1", [runEventAt(1, "run-1")]);
    clock.runFrame();
    registry.enqueue("session-1", [runEventAt(2, "run-2")]);
    clock.runFrame();

    expect(store.snapshot().revision).toBe(revisionBefore + 2);
    expect(registry.applyDrainCountFor("session-1")).toBe(2);
    registry.disposeAll();
  });

  it("coalesces refresh requests into one read and establishes what it returns", async () => {
    const clock = new ManualClock(0);
    const readCalls: RefreshReason[][] = [];
    const registry = new SessionStoreRegistry({
      clock,
      refreshDebounceMs: 20,
      refreshMaxWaitMs: 1000,
      read: (sessionId, reasons) => {
        readCalls.push([...reasons]);
        return Promise.resolve({
          cursor: 7,
          entities: [{ kind: "run", id: `${sessionId}-run`, state: "queued" }],
        });
      },
    });
    const store = registry.open("session-1");

    registry.requestRefresh("session-1", "subscribe");
    registry.requestRefresh("session-1", "window-focus");
    registry.requestRefresh("session-1", "reconnect");
    clock.advance(20);
    await crossMacrotaskBoundary();

    expect(readCalls).toStrictEqual([["subscribe", "window-focus", "reconnect"]]);
    expect(registry.refreshCountFor("session-1")).toBe(1);
    // The read establishes the store; the caller need not call `initialize`.
    expect(store.snapshot().initialized).toBe(true);
    expect(store.snapshot().cursor).toBe(7);
    expect(store.snapshot().partitions.run["session-1-run"]?.state).toBe("queued");
    registry.disposeAll();
  });

  it("marks the store degraded — with a cause — when the read fails", async () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      clock,
      refreshDebounceMs: 20,
      read: () => Promise.reject(new Error("the daemon did not answer")),
    });
    const store = registry.open("session-1");
    expect(store.snapshot().degradedCause).toBeUndefined();

    registry.requestRefresh("session-1", "reconnect");
    clock.advance(20);
    await crossMacrotaskBoundary();

    // Stale rows that look current are the failure this prevents.
    expect(store.snapshot().degradedCause).toBe("read-failed");
    registry.disposeAll();
  });

  it("requests a read of every open session on one window-level reason", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      refreshDebounceMs: 20,
    });
    registry.open("session-1");
    registry.open("session-2");

    registry.requestRefreshOfEverySession("window-focus");

    // Window focus reaches everything open at one armed timeout per session, not a poll.
    expect(clock.pendingCount).toBe(2);
    registry.disposeAll();
    expect(clock.pendingCount).toBe(0);
  });
});

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
        return Promise.resolve(emptyBaseState(5));
      },
    });
    const store = registry.open("session-1");
    store.initialize(emptyBaseState(0));

    registry.enqueue("session-1", [runEventAt(1, "run-1"), runEventAt(5, "run-5")]);
    clock.runFrame();

    // The store is short 2..4 and the drain armed the one read that can fill it, once.
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 4 }]);
    expect(clock.pendingCount).toBe(1);

    clock.advance(20);
    await crossMacrotaskBoundary();

    // Exactly one `gap-repull`: the reason names what asked and the count is the repair.
    expect(readCalls).toStrictEqual([["gap-repull"]]);
    expect(registry.refreshCountFor("session-1")).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
    registry.disposeAll();
  });
});
