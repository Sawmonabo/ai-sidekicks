// A delivered sequence the store cannot reconcile.
//
// The modes here are the ones arithmetic decides rather than ordering: a jump too
// wide to enumerate, a value `Date` and `Math.max` cannot carry, a hostile number
// sitting in a batch beside well-formed events, and an accumulated loss that would
// otherwise grow the range list one entry per hole for the life of the session.
//
// Every case asserts the REFUSAL — its count, and the cursor it left behind — because
// one `NaN` through a comparison makes every guard in the class evaluate false for
// the rest of the session, and nothing throws when it happens.
//
// The sibling suites of `failure-modes.test.ts` cover the other modes.

import { describe, expect, it } from "vitest";

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "../core/index.js";
import { eventAt } from "./failure-modes.test-support.js";
import { SessionStore } from "./session-store.js";

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
