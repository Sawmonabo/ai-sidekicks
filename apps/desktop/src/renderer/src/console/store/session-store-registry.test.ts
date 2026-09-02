// The per-session store lifecycle, and the two schedulers bound to it.
//
// `Spec-023 §Console Design (Meridian)` puts one store behind each OPEN session.
// The claims that need driving are the ones a bare `Map` in a component ref gets
// wrong: a second open of the same session is the same store, a close takes the
// queue and the scheduler with it, and a delivery for a session nobody has open
// refuses instead of throwing through the bridge's own subscription.
//
// Frozen clock throughout, so "no timer outlived the pane" is a count rather than
// a hope.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, ManualClock, isConsoleRefusal, refuse } from "../core/index.js";
import type { ConsoleSessionEvent, EntityProjectorRegistry } from "./entities.js";
import type { RefreshReason } from "./scheduling.js";
import {
  SESSION_REGISTRY_ORIGIN,
  SessionStoreRegistry,
  type SessionRegistryChange,
  type SessionSnapshotReader,
} from "./session-store-registry.js";
import type { SessionSnapshot } from "./session-store.js";

/** A reader that establishes nothing. The honest "no wire is registered" answer. */
const readsNothing: SessionSnapshotReader = () => Promise.resolve(undefined);

function runIdOf(event: ConsoleSessionEvent): string {
  const raw = event.payload?.["runId"];
  return typeof raw === "string" ? raw : "unknown-run";
}

/** One projector, so an applied event is observable as an entity rather than a count. */
const projectors: EntityProjectorRegistry = {
  "run.starting": (event) => [
    {
      operation: "upsert",
      entity: { kind: "run", id: runIdOf(event), state: "running" },
    },
  ],
};

function eventAt(sequence: number, runId: string): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    payload: { runId },
  };
}

function emptySnapshot(cursor: number): SessionSnapshot {
  return { cursor, entities: [], participantJoinLog: [] };
}

async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

describe("SessionStoreRegistry — one store per open session", () => {
  it("returns the SAME store for a second open of one session", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });

    const first = registry.open("session-1");
    const second = registry.open("session-1");
    const other = registry.open("session-2");

    // Two stores for one session would each hold half the stream, and every
    // surface would render whichever half it was handed.
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

  it("announces opens and closes through one emitter, and stops on unsubscribe", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    const changes: SessionRegistryChange[] = [];
    const unsubscribe = registry.subscribe((change) => {
      changes.push(change);
    });

    expect(registry.listenerCount).toBe(1);
    registry.open("session-1");
    registry.open("session-1");
    registry.close("session-1");
    unsubscribe();
    registry.open("session-2");

    // The idempotent second open announces nothing: nothing changed.
    expect(changes).toStrictEqual([
      { sessionId: "session-1", change: "opened" },
      { sessionId: "session-1", change: "closed" },
    ]);
    expect(registry.listenerCount).toBe(0);
    registry.disposeAll();
  });

  it("refuses — rather than throws — for a session that is not open", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });

    const refusal = registry.enqueue("session-gone", [eventAt(1, "run-1")]);

    expect(refusal).toBeDefined();
    expect(isConsoleRefusal(refusal)).toBe(true);
    expect(refusal?.origin).toBe(SESSION_REGISTRY_ORIGIN);
    expect(refusal?.code).toBe("session-not-open");
    expect(registry.requestRefresh("session-gone", "reconnect")?.code).toBe("session-not-open");
    expect(registry.flush("session-gone")?.code).toBe("session-not-open");

    // Negative control: the same three calls against an OPEN session return no
    // refusal, so the assertions above are about openness and not about the
    // methods always refusing.
    registry.open("session-1");
    expect(registry.enqueue("session-1", [eventAt(1, "run-1")])).toBeUndefined();
    expect(registry.requestRefresh("session-1", "reconnect")).toBeUndefined();
    expect(registry.flush("session-1")).toBeUndefined();
    registry.disposeAll();
  });

  it("throws a console refusal when a disposed registry is asked to open", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    registry.disposeAll();

    expect(registry.isDisposed).toBe(true);
    expect(() => registry.open("session-1")).toThrow(ConsoleRefusalError);
    try {
      registry.open("session-1");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleRefusalError);
      if (error instanceof ConsoleRefusalError) {
        expect(error.refusal.code).toBe("registry-disposed");
        expect(error.refusal.origin).toBe(SESSION_REGISTRY_ORIGIN);
      }
    }
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
