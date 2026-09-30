// What an authoritative re-read may do to a store that is already ahead, for a base state that
// arrives late. The repair read answers at the cursor the store already reached, which an "only
// a newer snapshot may land" guard would discard, leaving a hole nothing on the wire can fill.
// And the pre-initialization buffer holds events for a read that may never come, so its cap is a
// real loss that must be named. Assertions are on the refusal or recorded loss, not on the
// absence of a crash.

import { describe, expect, it } from "vitest";

import { PRE_INITIALIZATION_BUFFER_CAP } from "./session-store-caps.js";
import type { ProjectedSessionEvent } from "./entities/entities.js";
import { eventAt } from "./session-store.test-support.js";
import { SessionStore } from "./session-store.js";

describe("failure matrix — the repair read answers at the cursor the store already reached", () => {
  /**
   * A store that admitted event 7 over cursor 5: its cursor is 7, sequence 6 is missing and the
   * sticky flag is set. An authoritative re-pull answers through 7, the same cursor.
   */
  function degradedAtCursorSeven(): SessionStore {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 5, entities: [] });
    store.apply(eventAt(7));
    return store;
  }

  it("admits an equal-cursor snapshot into a degraded store and clears the gap", () => {
    const store = degradedAtCursorSeven();
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 6, toSequence: 6 }]);

    store.initialize({
      cursor: 7,
      entities: [],
      timeline: [eventAt(6), eventAt(7)],
    });

    // Discarding this snapshot would leave 6 missing and the banner stuck.
    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([6, 7]);
  });

  it("still refuses a snapshot BEHIND the cursor, so a racing re-read cannot rewind", () => {
    const store = degradedAtCursorSeven();
    const before = store.snapshot();

    store.initialize({
      cursor: 6,
      entities: [],
      timeline: [eventAt(6)],
    });

    // Same state object: the guard returned before any transition, so event 7 is kept.
    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().cursor).toBe(7);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("negative control: an equal-cursor snapshot on a HEALTHY store is a no-op", () => {
    // Guards against admitting every equal-cursor snapshot, which would rebuild the projection on
    // each focus refresh and empty the timeline for a snapshot carrying none.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });
    store.apply(eventAt(1));
    const before = store.snapshot();

    store.initialize({ cursor: 1, entities: [] });

    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1]);
  });
});

describe("failure matrix — events arrive before initialization and the read never comes", () => {
  function eventsFrom(count: number): ProjectedSessionEvent[] {
    return Array.from({ length: count }, (_unused, index) => eventAt(index + 1));
  }

  it("bounds the pre-initialization buffer, dropping the oldest and recording the loss", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    const overflowBy = 3;

    const outcome = store.applyBatch(eventsFrom(PRE_INITIALIZATION_BUFFER_CAP + overflowBy));

    expect(outcome.buffered).toBe(PRE_INITIALIZATION_BUFFER_CAP + overflowBy);
    expect(outcome.droppedBeforeInitialization).toBe(overflowBy);
    expect(store.preInitializationDropCount).toBe(overflowBy);
    expect(store.pendingPreInitializationCount).toBe(PRE_INITIALIZATION_BUFFER_CAP);
    // The loss is visible immediately, or a store whose read never comes would drop in silence.
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("re-derives exactly which sequences the cap cost, once a base state arrives", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    const overflowBy = 3;
    store.applyBatch(eventsFrom(PRE_INITIALIZATION_BUFFER_CAP + overflowBy));

    store.initialize({ cursor: 0, entities: [] });

    const timeline = store.snapshot().timeline;
    expect(timeline).toHaveLength(PRE_INITIALIZATION_BUFFER_CAP);
    expect(timeline[0]?.sequence).toBe(overflowBy + 1);
    expect(store.pendingPreInitializationCount).toBe(0);
    // The dropped sequences are named: the drain runs the same gap detection as any admission.
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 1, toSequence: 3 }]);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("negative control: a buffer inside the cap drops nothing and drains whole", () => {
    const store = new SessionStore({ sessionId: "session-1" });

    const outcome = store.applyBatch(eventsFrom(PRE_INITIALIZATION_BUFFER_CAP));
    expect(outcome.droppedBeforeInitialization).toBe(0);
    expect(store.preInitializationDropCount).toBe(0);
    expect(store.snapshot().degradedCause).toBeUndefined();

    store.initialize({ cursor: 0, entities: [] });

    expect(store.snapshot().timeline).toHaveLength(PRE_INITIALIZATION_BUFFER_CAP);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});
