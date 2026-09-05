// The rows and the calm reconcile conditions both viewport-controller suites drive.
//
// Two files reconcile the same controller — one about where a reader is held, one
// about what the window cap prunes — and both need a row list of a given length and
// the condition record that says "nothing is streaming". Written twice they would
// drift, and the second suite's claims would quietly stop being about the same
// reconcile as the first's.

import type { LedgerViewportRow } from "./viewport-snapshot.js";

/** `count` rows, optionally all under one chapter. */
export function syntheticRows(count: number, chapterKey?: string): readonly LedgerViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `${chapterKey ?? "row"}-${String(index)}`,
    parentKey: chapterKey,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** Reconcile conditions with nothing in flight — no turn, no reveal draining. */
export const CALM: { hasActiveTurn: boolean; isRevealDraining: boolean } = {
  hasActiveTurn: false,
  isRevealDraining: false,
};
