// What an authoritative re-read is allowed to do to a store that is already ahead.
//
// Two modes, and both are about the moment a base state arrives late. The repair
// read answers AT the cursor the store already reached, which a naive
// "only a newer snapshot may land" guard discards — leaving a hole nothing on the
// wire can ever fill. And the pre-initialisation buffer holds events for a read
// that may never come, so its cap is a real loss and the loss has to be named
// rather than absorbed.
//
// The sibling suites of `failure-modes.test.ts` cover the other modes; this one
// asserts on the REFUSAL or the recorded loss rather than merely on the absence of
// a crash, for the same reason they do.

import { describe, expect, it } from "vitest";

import { PRE_INITIALISATION_BUFFER_CAP } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { eventAt } from "./failure-modes.test-support.js";
import { SessionStore } from "./session-store.js";

describe("failure matrix — the repair read answers at the cursor the store already reached", () => {
  /**
   * The shape every case here starts from: a store that admitted event 7 over a
   * cursor of 5, so its own cursor is 7, sequence 6 is recorded missing, and the
   * sticky flag is set. An authoritative re-pull answers with everything through
   * 7 — the same cursor — because 7 is the newest sequence that exists.
   */
  function degradedAtCursorSeven(): SessionStore {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 5, entities: [], participantJoinLog: [] });
    store.apply(eventAt(7));
    return store;
  }

  it("admits an equal-cursor snapshot into a degraded store and clears the gap", () => {
    const store = degradedAtCursorSeven();
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 6, toSequence: 6 }]);

    store.initialise({
      cursor: 7,
      entities: [],
      participantJoinLog: [],
      timeline: [eventAt(6), eventAt(7)],
    });

    // Discarding this snapshot would have left sequence 6 missing from the
    // projection and the banner stuck until unrelated later activity happened to
    // push the session past 7 — a degraded state nothing on the wire can clear.
    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([6, 7]);
  });

  it("still refuses a snapshot BEHIND the cursor, so a racing re-read cannot rewind", () => {
    const store = degradedAtCursorSeven();
    const before = store.snapshot();

    store.initialise({
      cursor: 6,
      entities: [],
      participantJoinLog: [],
      timeline: [eventAt(6)],
    });

    // Same state object: the guard returned before any transition, so the store
    // did not lose event 7 to a read that had not seen it yet.
    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().cursor).toBe(7);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("negative control: an equal-cursor snapshot on a HEALTHY store is a no-op", () => {
    // Without this the case above would pass over a guard that admitted every
    // equal-cursor snapshot — which would rebuild the whole projection on each
    // ordinary focus refresh, and a snapshot carrying no timeline would empty the
    // one the store had.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.apply(eventAt(1));
    const before = store.snapshot();

    store.initialise({ cursor: 1, entities: [], participantJoinLog: [] });

    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1]);
  });
});

describe("failure matrix — events arrive before initialisation and the read never comes", () => {
  function eventsFrom(count: number): ConsoleSessionEvent[] {
    return Array.from({ length: count }, (_unused, index) => eventAt(index + 1));
  }

  it("bounds the pre-initialisation buffer, dropping the oldest and recording the loss", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    const overflowBy = 3;

    const outcome = store.applyBatch(eventsFrom(PRE_INITIALISATION_BUFFER_CAP + overflowBy));

    expect(outcome.buffered).toBe(PRE_INITIALISATION_BUFFER_CAP + overflowBy);
    expect(outcome.droppedBeforeInitialisation).toBe(overflowBy);
    expect(store.preInitialisationDropCount).toBe(overflowBy);
    expect(store.pendingPreInitialisationCount).toBe(PRE_INITIALISATION_BUFFER_CAP);
    // The loss is visible immediately rather than only once a read lands, because
    // a store whose read never comes would otherwise drop in silence forever.
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("re-derives exactly which sequences the cap cost, once a base state arrives", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    const overflowBy = 3;
    store.applyBatch(eventsFrom(PRE_INITIALISATION_BUFFER_CAP + overflowBy));

    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const timeline = store.snapshot().timeline;
    expect(timeline).toHaveLength(PRE_INITIALISATION_BUFFER_CAP);
    expect(timeline[0]?.sequence).toBe(overflowBy + 1);
    expect(store.pendingPreInitialisationCount).toBe(0);
    // The dropped sequences are named rather than guessed at: the drain runs the
    // same gap detection every other admission does.
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 1, toSequence: 3 }]);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("negative control: a buffer inside the cap drops nothing and drains whole", () => {
    const store = new SessionStore({ sessionId: "session-1" });

    const outcome = store.applyBatch(eventsFrom(PRE_INITIALISATION_BUFFER_CAP));
    expect(outcome.droppedBeforeInitialisation).toBe(0);
    expect(store.preInitialisationDropCount).toBe(0);
    expect(store.snapshot().degradedCause).toBeUndefined();

    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    expect(store.snapshot().timeline).toHaveLength(PRE_INITIALISATION_BUFFER_CAP);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});
