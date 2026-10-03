// The one act-wrapped settle, and the one derived debounce bound.
//
// The settle waits on a boundary, not a counted number of microtask passes: a hard-coded count is
// tuned to one case's promise chain, and when a reply grows one link deeper the case stops waiting
// and reports the absence of an answer still in flight, which goes quietly green.
// `crossMacrotaskBoundary` resolves on a macrotask, by which time every pending microtask chain
// has run at any depth. `act` wraps it so React flushes the effects each pass schedules; a case
// already inside an `act` body uses the sibling module's boundary alone.

import { act } from "@testing-library/react";

import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "./macrotask-boundary.js";

/**
 * Let every queued continuation reach React state, inside `act`, after running `advance` (a step
 * of a frozen clock or a scenario) in the same scope.
 *
 * One microtask turn is not enough where an arrival settles an effect that schedules the next,
 * and neither is a fixed count, so this crosses a macrotask boundary.
 */
export async function settle(advance?: () => void): Promise<void> {
  await act(async () => {
    advance?.();
    await crossMacrotaskBoundary();
  });
}

/**
 * A wait long enough to carry a debounced read past its window, derived from
 * `REFRESH_DEBOUNCE_MS` so a raised debounce moves every caller with it.
 */
export const PAST_REFRESH_DEBOUNCE_MS: number = REFRESH_DEBOUNCE_MS * 2;
