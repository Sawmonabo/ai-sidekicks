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

import {
  MAX_REPAIRABLE_SEQUENCE_GAP,
  PRE_INITIALISATION_BUFFER_CAP,
  consoleTripwires,
} from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { SessionStore } from "./session-store.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because the point of these cases is to assert that the
// breach was detected and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

/**
 * A stable wire timestamp per sequence.
 *
 * Separate from `eventAt` because several cases below deliver sequences `Date`
 * cannot represent at all — `NaN`, an infinity, a value far past the millisecond
 * range — and a helper that threw on them would fail the test before the store
 * ever saw the event it is supposed to refuse.
 */
function occurredAtFor(sequence: number): string {
  const startOfDay = Date.UTC(2026, 0, 1);
  const secondsIntoDay = Number.isSafeInteger(sequence) ? Math.min(Math.abs(sequence), 86_399) : 0;
  return new Date(startOfDay + secondsIntoDay * 1000).toISOString();
}

function eventAt(
  sequence: number,
  overrides: Partial<ConsoleSessionEvent> = {},
): ConsoleSessionEvent {
  return {
    sessionId: "session-1",
    sequence,
    kind: "run.starting",
    occurredAt: occurredAtFor(sequence),
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
    expect(store.snapshot().gaps).toStrictEqual([]);
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
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 3 }]);
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

describe("failure matrix — a delivered sequence the store cannot reconcile", () => {
  // The per-case timeout below is part of the claim: a store that enumerated the
  // jump would spend far longer than two seconds before producing any answer.
  it("settles a jump of a billion into the repair path instead of enumerating it", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1_000_000_000)]);

    // Nothing is admitted and nothing is enumerated: a hole a billion wide is
    // not a hole this store can fill, and walking it to say so would cost the
    // renderer the frame budget for the whole session before it could refuse.
    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().timeline).toHaveLength(0);
    // The cursor stays where an authoritative read can still answer at or ahead
    // of it. Advancing it to a billion would make every real repair a rewind.
    expect(store.snapshot().cursor).toBe(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  }, 2000);

  it("refuses a sequence too large to increment reliably rather than poisoning the cursor", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([
      eventAt(Number.MAX_SAFE_INTEGER),
      eventAt(Number.MAX_SAFE_INTEGER + 2),
      eventAt(Number.NaN),
      eventAt(Number.POSITIVE_INFINITY),
      eventAt(1.5),
    ]);

    expect(outcome.refusedDivergedSequence).toBe(5);
    expect(outcome.admitted).toBe(0);
    // The cursor is still a number a later comparison can act on. One `NaN`
    // through `Math.max` would have made every guard in the class evaluate false
    // for the rest of the session's life.
    expect(store.snapshot().cursor).toBe(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  });

  it("orders the rest of a batch normally even with an unusable sequence in it", () => {
    // The batch order is decided by a comparator, and the obvious subtraction
    // answers `NaN` here — which leaves the sort order of every well-formed event
    // beside it undefined. One hostile sequence must not decide where the real
    // ones land.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(3), eventAt(Number.NaN), eventAt(1)]);

    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.admitted).toBe(2);
    // Ordered, and the hole named once. Under the subtracting comparator this
    // exact batch sorts to `[3, NaN, 1]`, which appends 3 before 1 and records a
    // gap at 1–2 that the same batch then fills without saying so.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 3]);
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 2 }]);
  });

  it("refuses an unusable sequence before it is buffered, on a store with no base state", () => {
    // The pre-initialisation buffer exists to hold events until a base state can
    // make them applicable. No base state makes `NaN` applicable, so buffering it
    // would only defer the same refusal behind a drain.
    const store = new SessionStore({ sessionId: "session-1" });

    const outcome = store.applyBatch([eventAt(Number.NaN), eventAt(2)]);

    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.buffered).toBe(1);
    expect(store.pendingPreInitialisationCount).toBe(1);
  });

  it("bounds the total loss it will carry, not merely one jump", () => {
    // One-wide holes, repeated. Each of them is individually repairable and the
    // arithmetic of the class is what fails: a bound on a single jump would let
    // the range list grow one entry per hole for the life of the session.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const strided = Array.from({ length: MAX_REPAIRABLE_SEQUENCE_GAP + 8 }, (_unused, index) =>
      eventAt(index * 2 + 2),
    );
    const outcome = store.applyBatch(strided);

    expect(outcome.refusedDivergedSequence).toBeGreaterThan(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
    // A range is at least one sequence wide, so bounding the accumulated loss
    // bounds the list that records it.
    expect(store.snapshot().gaps.length).toBeLessThanOrEqual(MAX_REPAIRABLE_SEQUENCE_GAP);
  });

  it("negative control: a gap inside the bound still records a range and still repairs", () => {
    // Without this the cases above would pass over a store that had simply stopped
    // admitting anything with a hole in front of it.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(MAX_REPAIRABLE_SEQUENCE_GAP + 1)]);

    expect(outcome.refusedDivergedSequence).toBe(0);
    expect(outcome.admitted).toBe(2);
    expect(outcome.gapDetected).toBe(true);
    expect(store.snapshot().gaps).toStrictEqual([
      { fromSequence: 2, toSequence: MAX_REPAIRABLE_SEQUENCE_GAP },
    ]);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");

    store.initialise({
      cursor: MAX_REPAIRABLE_SEQUENCE_GAP + 1,
      entities: [],
      participantJoinLog: [],
    });

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
  });
});

describe("failure matrix — dedupe memory over a long-lived session", () => {
  it("releases the sequences the cursor already refuses, so the set stays a batch wide", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const batchSize = 100;
    const batchCount = 50;
    for (let batch = 0; batch < batchCount; batch += 1) {
      store.applyBatch(
        Array.from({ length: batchSize }, (_unused, index) =>
          eventAt(batch * batchSize + index + 1),
        ),
      );
    }

    expect(store.snapshot().cursor).toBe(batchSize * batchCount);
    // Every one of those sequences is at or below the cursor, and the cursor test
    // refuses them without help. Retaining them would have grown this set by one
    // number per event for as long as the session stayed open — behind a timeline
    // the cap had already trimmed.
    expect(store.retainedDedupeSequenceCount).toBe(0);
  });

  it("negative control: an in-batch duplicate is still rejected", () => {
    // The set's whole remaining job. A release that cleared it mid-batch would
    // admit the second copy of a sequence the same batch already carried.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(1), eventAt(2)]);

    expect(outcome.admitted).toBe(2);
    expect(outcome.duplicates).toBe(1);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2]);
  });

  it("negative control: a replay below the cursor is still rejected", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([eventAt(1), eventAt(2), eventAt(3)]);

    const replay = store.applyBatch([eventAt(2), eventAt(3)]);

    expect(replay.duplicates).toBe(2);
    expect(replay.admitted).toBe(0);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
  });
});

describe("failure matrix — a registered projector throws on an event", () => {
  const REJECTED_SEQUENCE = 3;

  function storeWithProjectorThrowingAt(sequence: number): SessionStore {
    return new SessionStore({
      sessionId: "session-1",
      projectors: {
        "run.starting": (event) => {
          if (event.sequence === sequence) {
            throw new TypeError("the payload was not the shape this projector claims");
          }
          return [
            {
              operation: "upsert",
              entity: { kind: "run", id: `run-${String(event.sequence)}` },
            },
          ];
        },
      },
    });
  }

  it("costs the event its entity contribution, never the batch and never the process", () => {
    const store = storeWithProjectorThrowingAt(REJECTED_SEQUENCE);
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([1, 2, 3, 4, 5].map((sequence) => eventAt(sequence)));

    expect(outcome.projectionFailures).toBe(1);
    expect(outcome.admitted).toBe(5);
    // The batch survives whole: the four events whose projection succeeded are
    // projected, the timeline holds all five, and the loss is NAMED rather than
    // absorbed, because only a re-pull can supply the mutation that did not run.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(store.snapshot().partitions.run).sort()).toStrictEqual([
      "run-1",
      "run-2",
      "run-4",
      "run-5",
    ]);
    expect(store.snapshot().degradedCause).toBe("projection-failed");
  });

  it("applies a failing event's mutations all or not at all", () => {
    // A projector that returns a good mutation and then a malformed one. Merging
    // the first before the second threw would leave a partition holding half of a
    // transition nothing will ever complete.
    const store = new SessionStore({
      sessionId: "session-1",
      projectors: {
        "run.starting": () => [
          { operation: "upsert", entity: { kind: "run", id: "run-half-applied" } },
          {
            operation: "upsert",
            entity: { kind: "not-a-kind" as never, id: "run-unmergeable" },
          },
        ],
      },
    });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1)]);

    expect(outcome.projectionFailures).toBe(1);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().degradedCause).toBe("projection-failed");
  });

  it("negative control: a projector that returns cleanly still projects and leaves no cause", () => {
    const store = storeWithProjectorThrowingAt(Number.NaN);
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(2)]);

    expect(outcome.projectionFailures).toBe(0);
    expect(Object.keys(store.snapshot().partitions.run).sort()).toStrictEqual(["run-1", "run-2"]);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});
