// A delivered sequence the store cannot reconcile: modes arithmetic decides rather than ordering
// (a jump too wide to enumerate, a value `Date` and `Math.max` cannot carry, a hostile number
// beside well-formed events, and accumulated loss growing the range list). Every case asserts
// the refusal and the cursor left behind, because one `NaN` makes every guard in the class false
// for the rest of the session without throwing.

import { describe, expect, it } from "vitest";

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "./session-store-caps.js";
import { eventAt } from "./session-store.test-support.js";
import { SessionStore } from "./session-store.js";

describe("failure matrix — a delivered sequence the store cannot reconcile", () => {
  // The per-case timeout is part of the claim: enumerating the jump would take far longer.
  it("settles a jump of a billion into the repair path instead of enumerating it", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1_000_000_000)]);

    // Nothing is admitted or enumerated; walking a billion-wide hole would cost the frame budget.
    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().timeline).toHaveLength(0);
    // The cursor stays where a read can answer at or ahead of it; a billion would make repairs
    // rewinds.
    expect(store.snapshot().cursor).toBe(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  }, 2000);

  it("refuses a sequence too large to increment reliably rather than poisoning the cursor", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([
      eventAt(Number.MAX_SAFE_INTEGER),
      eventAt(Number.MAX_SAFE_INTEGER + 2),
      eventAt(Number.NaN),
      eventAt(Number.POSITIVE_INFINITY),
      eventAt(1.5),
    ]);

    expect(outcome.refusedDivergedSequence).toBe(5);
    expect(outcome.admitted).toBe(0);
    // The cursor is still a number a later comparison can act on; `NaN` would break every guard.
    expect(store.snapshot().cursor).toBe(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  });

  it("orders the rest of a batch normally even with an unusable sequence in it", () => {
    // A subtracting comparator answers `NaN` here and leaves the batch order undefined; one
    // hostile sequence must not decide where the real ones land.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(3), eventAt(Number.NaN), eventAt(1)]);

    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.admitted).toBe(2);
    // Ordered, with the hole named once (a subtracting comparator would sort `[3, NaN, 1]`).
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 3]);
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 2 }]);
  });

  it("refuses an unusable sequence before it is buffered, on a store with no base state", () => {
    // No base state makes `NaN` applicable, so buffering it would only defer the refusal.
    const store = new SessionStore({ sessionId: "session-1" });

    const outcome = store.applyBatch([eventAt(Number.NaN), eventAt(2)]);

    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.buffered).toBe(1);
    expect(store.pendingPreInitializationCount).toBe(1);
  });

  it("bounds the total loss it will carry, not merely one jump", () => {
    // One-wide holes, repeated: each is repairable, and a per-jump bound would let the list grow.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const strided = Array.from({ length: MAX_REPAIRABLE_SEQUENCE_GAP + 8 }, (_unused, index) =>
      eventAt(index * 2 + 2),
    );
    const outcome = store.applyBatch(strided);

    expect(outcome.refusedDivergedSequence).toBeGreaterThan(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
    // A range is at least one sequence wide, so bounding the loss bounds the list.
    expect(store.snapshot().gaps.length).toBeLessThanOrEqual(MAX_REPAIRABLE_SEQUENCE_GAP);
  });

  it("negative control: a gap inside the bound still records a range and still repairs", () => {
    // Guards a store that simply stopped admitting anything with a hole in front of it.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(MAX_REPAIRABLE_SEQUENCE_GAP + 1)]);

    expect(outcome.refusedDivergedSequence).toBe(0);
    expect(outcome.admitted).toBe(2);
    expect(outcome.gapDetected).toBe(true);
    expect(store.snapshot().gaps).toStrictEqual([
      { fromSequence: 2, toSequence: MAX_REPAIRABLE_SEQUENCE_GAP },
    ]);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");

    store.initialize({
      cursor: MAX_REPAIRABLE_SEQUENCE_GAP + 1,
      entities: [],
    });

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
  });
});
