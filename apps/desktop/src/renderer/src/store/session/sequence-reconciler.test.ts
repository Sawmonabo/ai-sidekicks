// The reconciler in isolation: what it admits, refuses and records. The whole-store level is
// `session-store.failure-modes.test.ts`; this covers the reconciler's own memory between calls
// (cursor, released set, accumulated ranges), where a wrong answer persists for the session
// instead of failing the batch that caused it.

import { describe, expect, it } from "vitest";

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "./session-store-caps.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import {
  SequenceReconciler,
  isReconcilableSequence,
  orderBatchBySequence,
} from "./sequence-reconciler.js";

/** A reconciler re-based onto a read that answered at `cursor`, carrying no rows. */
function reconcilerAt(cursor: number): SequenceReconciler {
  const reconciler = new SequenceReconciler();
  reconciler.rebaseTo(cursor, []);
  return reconciler;
}

describe("which sequences cursor arithmetic can survive", () => {
  it("refuses every value a cursor comparison would be poisoned by", () => {
    for (const sequence of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(isReconcilableSequence(sequence)).toBe(false);
    }
  });

  it("negative control: an ordinary sequence and the largest safe one are reconcilable", () => {
    expect(isReconcilableSequence(7)).toBe(true);
    expect(isReconcilableSequence(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("sorts what it cannot carry to the end, leaving the rest in order", () => {
    const ordered = orderBatchBySequence([
      eventOfKind("session-1", "run.starting", 3),
      eventOfKind("session-1", "run.starting", Number.NaN),
      eventOfKind("session-1", "run.starting", 1),
    ]);

    // A subtracting comparator keeps this batch in input order, appending 3 before 1 and
    // recording a hole the same batch then fills silently.
    expect(ordered).toHaveLength(3);
    expect(ordered[0]?.sequence).toBe(1);
    expect(ordered[1]?.sequence).toBe(3);
    expect(ordered[2]?.sequence).toBeNaN();
  });
});

describe("the admitted run a reconciler carries", () => {
  it("advances the cursor over a contiguous run and opens no range", () => {
    const reconciler = reconcilerAt(0);

    for (const sequence of [1, 2, 3]) {
      expect(reconciler.reconcile(sequence)).toStrictEqual({
        outcome: "admitted",
        openedGap: undefined,
      });
    }

    expect(reconciler.cursor).toBe(3);
    expect(reconciler.gaps()).toStrictEqual([]);
  });

  it("records a hole as one range rather than one entry per sequence", () => {
    const reconciler = reconcilerAt(0);

    const admission = reconciler.reconcile(5);

    expect(admission).toStrictEqual({
      outcome: "admitted",
      openedGap: { fromSequence: 1, toSequence: 4 },
    });
    expect(reconciler.gaps()).toStrictEqual([{ fromSequence: 1, toSequence: 4 }]);
    expect(reconciler.cursor).toBe(5);
  });

  it("hands out a copy of its ranges, so a later admission cannot mutate committed state", () => {
    const reconciler = reconcilerAt(0);
    reconciler.reconcile(3);
    const committed = reconciler.gaps();

    reconciler.reconcile(9);

    // A shared list would grow the array the store already committed and React has rendered.
    expect(committed).toStrictEqual([{ fromSequence: 1, toSequence: 2 }]);
    expect(reconciler.gaps()).toHaveLength(2);
  });

  it("refuses a sequence inside a hole it already recorded, as a duplicate", () => {
    // The cursor refuses this, not the dedupe set (3 was never admitted). Testing against the
    // batch-start cursor would admit it and record an overlapping second range.
    const reconciler = reconcilerAt(0);
    reconciler.reconcile(5);

    expect(reconciler.reconcile(3)).toStrictEqual({ outcome: "duplicate" });
    expect(reconciler.cursor).toBe(5);
    expect(reconciler.gaps()).toHaveLength(1);
  });

  it("refuses a jump past the accumulated bound without moving the cursor", () => {
    const reconciler = reconcilerAt(0);

    expect(reconciler.reconcile(MAX_REPAIRABLE_SEQUENCE_GAP + 3)).toStrictEqual({
      outcome: "diverged",
    });

    // Advancing would put the cursor where no authoritative read need answer.
    expect(reconciler.cursor).toBe(0);
    expect(reconciler.gaps()).toStrictEqual([]);
  });

  it("negative control: a hole exactly at the bound is still admitted and still recorded", () => {
    const reconciler = reconcilerAt(0);

    const admission = reconciler.reconcile(MAX_REPAIRABLE_SEQUENCE_GAP + 1);

    expect(admission).toStrictEqual({
      outcome: "admitted",
      openedGap: { fromSequence: 1, toSequence: MAX_REPAIRABLE_SEQUENCE_GAP },
    });
    expect(reconciler.cursor).toBe(MAX_REPAIRABLE_SEQUENCE_GAP + 1);
  });
});

describe("dedupe memory between batches", () => {
  it("refuses a repeat inside a batch and empties at the boundary", () => {
    const reconciler = reconcilerAt(0);
    reconciler.reconcile(1);

    // Within the batch only the set can refuse this; the release has not run yet.
    expect(reconciler.reconcile(1)).toStrictEqual({ outcome: "duplicate" });
    expect(reconciler.retainedSequenceCount).toBe(1);

    reconciler.releaseSequencesAtOrBelowCursor();

    expect(reconciler.retainedSequenceCount).toBe(0);
    // Still refused after the release: the cursor answers for it now.
    expect(reconciler.reconcile(1)).toStrictEqual({ outcome: "duplicate" });
  });

  it("re-bases onto a read: no ranges, the read's cursor, and its rows released", () => {
    const reconciler = reconcilerAt(0);
    reconciler.reconcile(7);
    expect(reconciler.gaps()).toHaveLength(1);

    reconciler.rebaseTo(7, [6, 7]);

    expect(reconciler.cursor).toBe(7);
    expect(reconciler.gaps()).toStrictEqual([]);
    // Both seeded sequences are at or below the new cursor, so the set holds nothing.
    expect(reconciler.retainedSequenceCount).toBe(0);
    expect(reconciler.reconcile(8)).toStrictEqual({ outcome: "admitted", openedGap: undefined });
  });
});
