// The per-session store lifecycle: a second open of one session is the same store, a close
// forgets it, and a delivery for a session nobody has open refuses instead of throwing through
// the bridge's subscription. The schedulers have their own files:
// `session-store-registry.scheduling.test.ts` and `session-store-registry.gap-repair.test.ts`.

import { describe, expect, it } from "vitest";

import { RefusalError, isRefusal } from "@renderer/lib/refusal.js";
import { ManualClock } from "@renderer/lib/clock.js";
import {
  emptySnapshot,
  runEventAt,
  readsNothing,
  settleMicrotasks,
} from "@test/helpers/session-store-fixtures.js";
import {
  SESSION_REGISTRY_ORIGIN,
  SessionStoreRegistry,
  type SessionRegistryChange,
} from "./session-store-registry.js";

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

  it("raises a degraded cause on one session's store, through the same ladder an apply uses", () => {
    // The route the session-event subscriber takes for a stream that never opened. It holds no
    // store, so the cause travels through the registry as an event and a refresh reason do.
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    const store = registry.open("session-1");

    expect(registry.markDegraded("session-1", "subscription-closed")).toBeUndefined();
    expect(store.snapshot().degradedCause).toBe("subscription-closed");

    // Merged, not assigned: a diverged store is no less broken because its subscription closed.
    registry.markDegraded("session-1", "stream-diverged");
    registry.markDegraded("session-1", "subscription-closed");
    expect(store.snapshot().degradedCause).toBe("stream-diverged");

    // Negative control: an untouched store carries no cause.
    const untouched = registry.open("session-2");
    expect(untouched.snapshot().degradedCause).toBeUndefined();
    registry.disposeAll();
  });

  it("stops telling a resume subscriber that unsubscribed, and drops every sink on dispose", async () => {
    // Sinks close over a React subscription of a tree that may have unmounted, so one kept after
    // its `Unsubscribe` ran, or left by `disposeAll`, would hold that tree alive.
    const clock = new ManualClock(0);
    const settledFor: string[] = [];
    const registry = new SessionStoreRegistry({
      clock,
      refreshDebounceMs: 20,
      read: () => Promise.resolve(emptySnapshot(0)),
    });
    registry.open("session-1");
    const unsubscribe = registry.subscribeToTimelineResume((sessionId) => {
      settledFor.push(sessionId);
    });
    expect(registry.resumeSettlementListenerCount).toBe(1);

    registry.requestRefresh("session-1", "reconnect");
    clock.advance(20);
    await settleMicrotasks();
    expect(settledFor).toStrictEqual(["session-1"]);

    unsubscribe();
    registry.requestRefresh("session-1", "window-focus");
    clock.advance(20);
    await settleMicrotasks();

    // The read really happened, so the unchanged list is about a dropped sink.
    expect(registry.refreshCountFor("session-1")).toBe(2);
    expect(settledFor).toStrictEqual(["session-1"]);
    expect(registry.resumeSettlementListenerCount).toBe(0);

    // The teardown drops a sink nobody unsubscribed; after `disposeAll` nothing could raise one.
    registry.subscribeToTimelineResume(() => {
      settledFor.push("after-dispose");
    });
    expect(registry.resumeSettlementListenerCount).toBe(1);
    registry.disposeAll();
    expect(registry.resumeSettlementListenerCount).toBe(0);
  });

  it("wakes a resume subscriber when its session closes, and the decision is gone", () => {
    // Nothing else would wake it: without this a reading would keep rendering the last settled
    // decision for a session the registry has forgotten.
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    const settledFor: string[] = [];
    registry.open("session-1");
    const unsubscribe = registry.subscribeToTimelineResume((sessionId) => {
      settledFor.push(sessionId);
    });

    registry.close("session-1");

    expect(settledFor).toStrictEqual(["session-1"]);
    expect(registry.timelineResumeFor("session-1")).toBeUndefined();
    // Idempotent close announces nothing: no session, no settlement.
    registry.close("session-1");
    expect(settledFor).toStrictEqual(["session-1"]);
    unsubscribe();
    registry.disposeAll();
  });

  it("throws a console refusal when a disposed registry is asked to open", () => {
    const registry = new SessionStoreRegistry({ read: readsNothing, clock: new ManualClock(0) });
    registry.disposeAll();

    expect(registry.isDisposed).toBe(true);
    expect(() => registry.open("session-1")).toThrow(RefusalError);
    try {
      registry.open("session-1");
    } catch (error) {
      expect(error).toBeInstanceOf(RefusalError);
      if (error instanceof RefusalError) {
        expect(error.refusal.code).toBe("registry-disposed");
        expect(error.refusal.origin).toBe(SESSION_REGISTRY_ORIGIN);
      }
    }
  });
});
