// The reconciler's recorded ranges are committed into immutable store state, so the list it hands
// out must be a copy: a shared array would let the next admission mutate a state React has
// already rendered. The store-level ordering, dedupe and divergence cases are in
// `session-store.test.ts`.

import { describe, expect, it } from "vitest";

import { SequenceReconciler } from "./sequence-reconciler.js";

/** A reconciler re-based onto a read that answered at `cursor`, carrying no rows. */
function reconcilerAt(cursor: number): SequenceReconciler {
  const reconciler = new SequenceReconciler();
  reconciler.rebaseTo(cursor, []);
  return reconciler;
}

describe("the admitted run a reconciler carries", () => {
  it("hands out a copy of its ranges, so a later admission cannot mutate committed state", () => {
    const reconciler = reconcilerAt(0);
    reconciler.reconcile(3);
    const committed = reconciler.gaps();

    reconciler.reconcile(9);

    // A shared list would grow the array the store already committed and React has rendered.
    expect(committed).toStrictEqual([{ fromSequence: 1, toSequence: 2 }]);
    expect(reconciler.gaps()).toHaveLength(2);
  });
});
