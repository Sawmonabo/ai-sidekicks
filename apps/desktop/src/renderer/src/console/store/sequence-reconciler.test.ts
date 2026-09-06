// The reconciler in isolation: what it admits, what it refuses, and what it records.
//
// `failure-modes.test.ts` drives these same rules through the whole store, which is
// the right level for "the chokepoint survived a hostile batch". This file covers
// the level that one cannot reach: the reconciler's own memory between calls — the
// cursor it advances, the set it releases, and the ranges it accumulates — where a
// wrong answer is a state the store will carry for the session's life rather than a
// visible failure of the batch that caused it.

import { describe, expect, it } from "vitest";

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "../core/index.js";
import { eventOfKind } from "./session-event.test-support.js";
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

    // Under the obvious subtracting comparator this exact batch keeps its input
    // order, which appends 3 before 1 and records a hole the same batch then fills
    // without saying so.
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

    // A reconciler that answered its own list would have grown the array the store
    // already committed — a value React has rendered, changing under it with no
    // transition and no notification.
    expect(committed).toStrictEqual([{ fromSequence: 1, toSequence: 2 }]);
    expect(reconciler.gaps()).toHaveLength(2);
  });

  it("refuses a sequence inside a hole it already recorded, as a duplicate", () => {
    // The cursor is what refuses this, not the dedupe set: 3 was never admitted, so
    // the set has never held it. A reconciler that tested against the cursor it had
    // at the START of a batch rather than the one it has now would admit it and
    // record a second, overlapping range for rows already counted missing.
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

    // Advancing here would put the cursor somewhere no authoritative read need ever
    // answer at, and every real repair would then be refused as a rewind.
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

    // Within the batch the set is the only thing that can refuse this, because the
    // release has not run yet and the cursor test alone would let it through on a
    // reconciler that advanced lazily.
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
    // Both seeded sequences are at or below the new cursor, so the cursor refuses
    // them on its own and the set holds nothing.
    expect(reconciler.retainedSequenceCount).toBe(0);
    expect(reconciler.reconcile(8)).toStrictEqual({ outcome: "admitted", openedGap: undefined });
  });
});
