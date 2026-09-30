// How the apply chokepoint admits what arrives, and what it records when it cannot: an event
// that came early, one addressed elsewhere, one that skipped a sequence, a subscriber writing
// back during notification, and the dedupe set over a long-lived session. The other modes are in
// `session-store.repair.test.ts` (authoritative re-read, pre-initialization cap),
// `session-store.sequence.test.ts` (unreconcilable sequences) and
// `session-store.projection-failure.test.ts` (a throwing projector).
//
// Where the code should have refused, the assertion is on the refusal (count, tripwire, detail)
// rather than the absence of a crash, since not throwing is not behaving correctly.

import { beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { eventAt } from "./session-store.test-support.js";
import { SessionStore } from "./session-store.js";

// Tripwires throw in development. Under test they are recorded, since the re-entrancy case
// asserts the breach was detected and described; a throw would only prove it was noticed.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("failure matrix — a bridge event arrives before the store is initialized", () => {
  it("buffers rather than dropping, and drains in sequence order once initialized", () => {
    const store = new SessionStore({ sessionId: "session-1" });

    const early = store.applyBatch([eventAt(3), eventAt(2)]);
    expect(early.admitted).toBe(0);
    expect(early.buffered).toBe(2);
    expect(store.snapshot().timeline).toHaveLength(0);

    store.initialize({ cursor: 1, entities: [] });

    // Both buffered events land ordered with no gap: they were only early, never missing.
    const timeline = store.snapshot().timeline;
    expect(timeline.map((event) => event.sequence)).toStrictEqual([2, 3]);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().cursor).toBe(3);
  });

  it("refuses an event addressed to another session instead of mixing it in", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1, { sessionId: "session-2" })]);

    expect(outcome.refusedForeignSession).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().timeline).toHaveLength(0);
  });

  it("records the missing sequences when a gap opens rather than renumbering", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(4)]);

    expect(outcome.gapDetected).toBe(true);
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 3 }]);
  });
});

describe("failure matrix — a subscriber writes back into the apply chokepoint", () => {
  it("queues the re-entrant batch, applies it, and names the subscriber as the defect", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    let hasReentered = false;
    const unsubscribe = store.readable.subscribe(() => {
      if (hasReentered) {
        return;
      }
      hasReentered = true;
      // Models an effect writing during notification, which unguarded would interleave two
      // transitions with the second's `current` already stale.
      store.applyBatch([eventAt(2)]);
    });

    const outcome = store.applyBatch([eventAt(1)]);
    unsubscribe();

    expect(outcome.admitted).toBe(1);
    // The re-entrant events are applied after the outer batch settles, and the breach is recorded.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2]);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    const report = windowTripwires.reports()[0];
    expect(report?.detail).toContain("re-entrant applyBatch");
  });

  it("applies a duplicate sequence exactly once", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

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
    store.initialize({ cursor: 0, entities: [] });

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
    // Every sequence is at or below the cursor, which refuses them alone; retaining them would
    // grow the set by one number per event for the session's life.
    expect(store.retainedDedupeSequenceCount).toBe(0);
  });

  it("negative control: an in-batch duplicate is still rejected", () => {
    // The set's remaining job: clearing it mid-batch would admit a repeat within the batch.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(1), eventAt(2)]);

    expect(outcome.admitted).toBe(2);
    expect(outcome.duplicates).toBe(1);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2]);
  });

  it("negative control: a replay below the cursor is still rejected", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });
    store.applyBatch([eventAt(1), eventAt(2), eventAt(3)]);

    const replay = store.applyBatch([eventAt(2), eventAt(3)]);

    expect(replay.duplicates).toBe(2);
    expect(replay.admitted).toBe(0);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
  });
});
