// The per-session store lifecycle.
//
// `Spec-023 §Console Design (Meridian)` puts one store behind each OPEN session.
// The claims that need driving are the ones a bare `Map` in a component ref gets
// wrong: a second open of the same session is the same store, a close forgets it,
// and a delivery for a session nobody has open refuses instead of throwing through
// the bridge's own subscription.
//
// The two schedulers bound to that lifecycle have their own files:
// `session-store-registry.scheduling.test.ts` for the queue and the refresh read,
// `session-store-registry.gap-repair.test.ts` for the repair a lossy delivery arms.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, ManualClock, isConsoleRefusal } from "../core/index.js";
import {
  emptySnapshot,
  eventAt,
  readsNothing,
  settleMicrotasks,
} from "./session-store-registry.test-support.js";
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

  it("stops telling a resume subscriber that unsubscribed, and drops every sink on dispose", async () => {
    // The second fan-out, and it had neither claim driven. Its sinks each close over
    // a React subscription belonging to a tree that may already have unmounted, so a
    // subscriber the registry keeps calling after its `Unsubscribe` ran — or one
    // `disposeAll` leaves attached — holds that tree alive for the life of the window.
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

    // The read really did happen — otherwise the unchanged list below would be about
    // a refresh that never landed rather than about a sink that was dropped.
    expect(registry.refreshCountFor("session-1")).toBe(2);
    expect(settledFor).toStrictEqual(["session-1"]);
    expect(registry.resumeSettlementListenerCount).toBe(0);

    // And the teardown drops a sink nobody unsubscribed, which is the half no
    // settlement can report: `disposeAll` closes every entry in the same act, so
    // after it there is nothing left that could raise one.
    registry.subscribeToTimelineResume(() => {
      settledFor.push("after-dispose");
    });
    expect(registry.resumeSettlementListenerCount).toBe(1);
    registry.disposeAll();
    expect(registry.resumeSettlementListenerCount).toBe(0);
  });

  it("wakes a resume subscriber when its session closes, and the decision is gone", () => {
    // Nothing else would: the store's revision does not move for a session that no
    // longer has a store, so a reading left holding the last settled decision would
    // keep rendering it for a session the registry has forgotten.
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
