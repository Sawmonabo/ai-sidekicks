// Rows, calm reconcile conditions and an attached controller shared by both viewport-controller
// suites, so their claims stay about the same reconcile.

import { ManualClock } from "@renderer/lib/clock.js";
import type { ViewportRow } from "./viewport-snapshot.js";
import { ViewportController } from "./viewport-controller.js";

/** `count` rows, optionally all under one run group. */
export function syntheticRows(count: number, runGroupKey?: string): readonly ViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `${runGroupKey ?? "row"}-${String(index)}`,
    parentKey: runGroupKey,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** Reconcile conditions with nothing in flight — no turn, no reveal draining. */
export const CALM: { hasActiveTurn: boolean; isRevealDraining: boolean } = {
  hasActiveTurn: false,
  isRevealDraining: false,
};

/** Rows named by key, for the cases about which END of the window a set grew at. */
export function rowsFrom(keys: readonly string[]): readonly ViewportRow[] {
  return keys.map((key) => ({ key, parentKey: undefined, rootCursor: `cursor-${key}` }));
}

/** A controller attached to a detached element, with the clock its cases advance. */
export function attachedController(): {
  controller: ViewportController;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new ViewportController({ clock });
  controller.attach(document.createElement("div"));
  return { controller, clock };
}
