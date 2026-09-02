// Applies go through the queue, reads through the scheduler.
//
// Frozen clock throughout, so "one drain per frame", "one read per burst", and "no
// timer outlived the pane" are counts rather than hopes. The registry owns both
// schedulers, so it is the only place their composition — a burst coalescing into
// one transition while a window-level reason still reaches every open session — can
// be driven at all.
//
// The lifecycle those schedulers hang off is `session-store-registry.test.ts`; the
// repair a lossy delivery arms is `session-store-registry.gap-repair.test.ts`.

import { describe, expect, it } from "vitest";

import { ManualClock, refuse } from "../core/index.js";
import type { RefreshReason } from "./scheduling.js";
import {
  emptySnapshot,
  eventAt,
  projectors,
  readsNothing,
  settleMicrotasks,
} from "./session-store-registry.test-support.js";
import { SessionStoreRegistry } from "./session-store-registry.js";

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
    store.initialise(emptySnapshot(0));
    const revisionBefore = store.snapshot().revision;

    registry.enqueue("session-1", [eventAt(1, "run-1"), eventAt(2, "run-2")]);
    registry.enqueue("session-1", [eventAt(3, "run-3")]);

    // Nothing has reached the store yet: the queue holds the frame.
    expect(store.snapshot().revision).toBe(revisionBefore);
    expect(clock.pendingFrameCount).toBe(1);

    clock.runFrame();

    // Three events, ONE revision. Four streaming lanes cost one render.
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

  it("negative control: two frames are two transitions", () => {
    // Without this, a store frozen after its first transition would pass the
    // "one revision" case above by never transitioning again.
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      applyCoalesceMs: 0,
    });
    const store = registry.open("session-1");
    store.initialise(emptySnapshot(0));
    const revisionBefore = store.snapshot().revision;

    registry.enqueue("session-1", [eventAt(1, "run-1")]);
    clock.runFrame();
    registry.enqueue("session-1", [eventAt(2, "run-2")]);
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
          participantJoinLog: ["participant-1"],
        });
      },
    });
    const store = registry.open("session-1");

    registry.requestRefresh("session-1", "subscribe");
    registry.requestRefresh("session-1", "window-focus");
    registry.requestRefresh("session-1", "reconnect");
    clock.advance(20);
    await settleMicrotasks();

    expect(readCalls).toStrictEqual([["subscribe", "window-focus", "reconnect"]]);
    expect(registry.refreshCountFor("session-1")).toBe(1);
    // The read is what establishes the store; the registry does not make the
    // caller remember to call `initialise` afterwards.
    expect(store.snapshot().initialised).toBe(true);
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
    await settleMicrotasks();

    // Stale rows that look current are the failure this prevents.
    expect(store.snapshot().degradedCause).toBe("read-failed");
    registry.disposeAll();
  });

  it("performs no read, and reports why, when it was handed a refusal instead of a reader", async () => {
    // The arm a bridge with no session wire takes. Two claims, and both matter:
    // nothing is read, so the scheduler fires into nothing rather than into an
    // undefined call; and the store is NOT marked degraded, because no read was
    // attempted and "we could not re-read" would be a different and false story.
    const clock = new ManualClock(0);
    const readRefusal = refuse(
      "growth-port",
      "wire-unregistered",
      "no session read is registered.",
    );
    const registry = new SessionStoreRegistry({ clock, refreshDebounceMs: 20, read: readRefusal });
    const store = registry.open("session-1");

    registry.requestRefresh("session-1", "subscribe");
    clock.advance(20);
    await settleMicrotasks();

    expect(registry.canInitialiseSessionStores).toBe(false);
    expect(registry.readRefusal).toBe(readRefusal);
    expect(store.snapshot().initialised).toBe(false);
    expect(store.snapshot().degradedCause).toBeUndefined();
    registry.disposeAll();
  });

  it("leaves no armed timer behind a closed session", () => {
    const clock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: readsNothing,
      clock,
      projectors,
      refreshDebounceMs: 20,
      applyCoalesceMs: 0,
    });
    registry.open("session-1");
    registry.enqueue("session-1", [eventAt(1, "run-1")]);
    registry.requestRefresh("session-1", "subscribe");

    // Two arms live: one frame for the queue, one timeout for the scheduler.
    expect(clock.pendingCount).toBe(2);

    registry.close("session-1");

    expect(clock.pendingCount).toBe(0);
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

    // Window focus is a refresh reason for everything open, and it still costs one
    // armed timeout per session rather than a poll.
    expect(clock.pendingCount).toBe(2);
    registry.disposeAll();
    expect(clock.pendingCount).toBe(0);
  });
});
