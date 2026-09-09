// The rows, the calm reconcile conditions, and the attached controller both
// viewport-controller suites drive.
//
// Two files reconcile the same controller — one about where a reader is held, one
// about what the window cap prunes — and both need a row list of a given length and
// the condition record that says "nothing is streaming". Written twice they would
// drift, and the second suite's claims would quietly stop being about the same
// reconcile as the first's.

import { ManualClock } from "../../../../core/index.js";
import type { LedgerViewportRow } from "../surface/viewport-snapshot.js";
import { LedgerViewportController } from "./viewport-controller.js";

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

/** Rows named by key, for the cases about which END of the window a set grew at. */
export function rowsFrom(keys: readonly string[]): readonly LedgerViewportRow[] {
  return keys.map((key) => ({ key, parentKey: undefined, rootCursor: `cursor-${key}` }));
}

/** A controller attached to a detached element, with the clock its cases advance. */
export function attachedController(): {
  controller: LedgerViewportController;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new LedgerViewportController({ clock });
  controller.attach(document.createElement("div"));
  return { controller, clock };
}
