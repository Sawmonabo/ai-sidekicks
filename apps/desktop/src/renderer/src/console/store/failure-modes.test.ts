// Failure modes of the apply chokepoint.
//
// The class: every way a batch can reach `SessionStore.applyBatch` at a moment the
// store is not ready for it — before `initialise`, addressed to another session,
// with a hole in its sequence run, twice, or from inside the store's own
// notification. These are the modes a happy-path test never reaches, because a
// happy path arrives initialised, in order, once, and from outside.
//
// They live in `store/` because the subject is the chokepoint itself: what it
// admits, what it buffers, what it refuses, and what it records when a caller
// breaches it. The scenario engine that feeds it and the persistence layer that
// outlives it have their own `failure-modes.test.ts`, covering their own subjects.
//
// Where a mode has a "the code should have refused" shape, the assertion is on the
// REFUSAL — its count, its tripwire, its detail — rather than merely on the absence
// of a crash. Not throwing is not the same as behaving correctly, and the
// difference is where every silent-corruption bug lives.

import { beforeEach, describe, expect, it } from "vitest";

import { PRE_INITIALISATION_BUFFER_CAP, consoleTripwires } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { SessionStore } from "./session-store.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because the point of these cases is to assert that the
// breach was detected and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

function eventAt(
  sequence: number,
  overrides: Partial<ConsoleSessionEvent> = {},
): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    ...overrides,
  };
}

describe("failure matrix — a bridge event arrives before the store is initialised", () => {
  it("buffers rather than dropping, and drains in sequence order once initialised", () => {
    const store = new SessionStore({ sessionId: "session-1" });

    const early = store.applyBatch([eventAt(3), eventAt(2)]);
    expect(early.admitted).toBe(0);
    expect(early.buffered).toBe(2);
    expect(store.snapshot().timeline).toHaveLength(0);

    store.initialise({ cursor: 1, entities: [], participantJoinLog: [] });

    // Both buffered events land, ordered, with no gap recorded: the events were
    // never missing, only early. Dropping them would have left a hole the console
    // could only heal with a full re-pull.
    const timeline = store.snapshot().timeline;
    expect(timeline.map((event) => event.sequence)).toStrictEqual([2, 3]);
    expect(store.snapshot().gapSequences).toStrictEqual([]);
    expect(store.snapshot().cursor).toBe(3);
  });

  it("refuses an event addressed to another session instead of mixing it in", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1, { sessionId: "session-2" })]);

    expect(outcome.refusedForeignSession).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().timeline).toHaveLength(0);
  });

  it("records the missing sequences when a gap opens rather than renumbering", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(4)]);

    expect(outcome.gapDetected).toBe(true);
    expect(store.snapshot().gapSequences).toStrictEqual([2, 3]);
  });
});

describe("failure matrix — a subscriber writes back into the apply chokepoint", () => {
  it("queues the re-entrant batch, applies it, and names the subscriber as the defect", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    let hasReentered = false;
    const unsubscribe = store.readable.subscribe(() => {
      if (hasReentered) {
        return;
      }
      hasReentered = true;
      // The bug this models: a selector-driven effect that writes during
      // notification. Left unguarded it interleaves two transitions and the
      // second one's `current` snapshot is already stale.
      store.applyBatch([eventAt(2)]);
    });

    const outcome = store.applyBatch([eventAt(1)]);
    unsubscribe();

    expect(outcome.admitted).toBe(1);
    // The re-entrant events are not lost — they are applied after the outer batch
    // settles, so state stays consistent — but the breach is recorded.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    const report = consoleTripwires.reports()[0];
    expect(report?.detail).toContain("re-entrant applyBatch");
  });

  it("applies a duplicate sequence exactly once", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    store.applyBatch([eventAt(1)]);
    const second = store.applyBatch([eventAt(1)]);

    expect(second.duplicates).toBe(1);
    expect(second.admitted).toBe(0);
    expect(store.snapshot().timeline).toHaveLength(1);
  });
});

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
    expect(store.snapshot().gapSequences).toStrictEqual([6]);

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
    expect(store.snapshot().gapSequences).toStrictEqual([]);
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
    expect(store.snapshot().gapSequences).toStrictEqual([1, 2, 3]);
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
    expect(store.snapshot().gapSequences).toStrictEqual([]);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});
