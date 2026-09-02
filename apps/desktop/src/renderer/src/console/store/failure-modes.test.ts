// How the apply chokepoint admits what arrives, and what it records when it cannot.
//
// The class: every way a batch can reach `SessionStore.applyBatch` at a moment the
// store is not ready for it. This file owns the three that are about ARRIVAL — an
// event that came early, one addressed elsewhere, one that skipped a sequence —
// plus the two the chokepoint answers with memory: a subscriber writing back during
// notification, and the dedupe set over a long-lived session. The other modes have
// their own files: `failure-modes.repair.test.ts` for the authoritative re-read and
// the pre-initialisation cap, `failure-modes.sequence.test.ts` for a delivered
// sequence the store cannot reconcile, and `failure-modes.projection.test.ts` for a
// projector that throws.
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

import { consoleTripwires } from "../core/index.js";
import { eventAt } from "./failure-modes.test-support.js";
import { SessionStore } from "./session-store.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED, because the re-entrancy case below asserts that the breach was
// detected and described — a throw would only prove it was noticed. This file is the
// only one of the four that can reach a tripwire: `applyBatch`'s re-entrancy guard
// is the store's single `reportTripwire` call site.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

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
