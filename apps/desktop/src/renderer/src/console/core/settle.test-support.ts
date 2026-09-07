// The one act-wrapped settle, and the one derived debounce bound.
//
// Nine suites wrote this loop, differing only in the bound they passed (3, 3, 3, 4,
// 4, 4, 6, 8) and in nothing else — same `act`, same wait, same shape. A loop written
// nine times is a loop fixed once: a surface that grows one more chained effect gets
// its own copy raised, and the eight that flush one pass too few then assert against
// a tree one settlement behind, intermittently, because the short count wins on a
// fast machine.
//
// THE BOUND IS GONE, AND ITS ABSENCE IS THE POINT. Those eight numbers were tuned
// against whatever promise chain each case happened to be written over, which is the
// defect `test/console/architecture/act-settling.test.ts` forbids: a reply that grows
// one link deeper stops being waited for, and the case then reports the ABSENCE of an
// answer that was merely still in flight — silent in exactly the direction that
// matters, because a presence claim fails loudly and an absence claim goes quietly
// green. So the wait is a BOUNDARY: `crossMacrotaskBoundary` beside this module
// resolves on a macrotask, by which time every pending microtask chain has run
// whatever its depth, and no caller has to say how deep its own runs.
//
// WHAT IS SHARED IS THE SCOPE. `act` around that boundary, so React flushes the
// effects each pass schedules — a state write raised from a promise callback outside
// React's scope is applied without the surrounding commit, and an assertion taken
// next reads the render before it. The boundary alone, for a case already inside an
// `act` body, is the sibling module's own export.
//
// It lives in `core/` for the reason `frozen-instant.test-support.ts` does: it is
// the bottom of the family DAG, so a view family, a store suite, and a settings page
// all reach it without one of them having to import another's family.
// `core/committed-frame.test-support.tsx` is the precedent that this family may hold
// a React-importing test-support module.

import { act } from "@testing-library/react";

import { REFRESH_DEBOUNCE_MS } from "./constants.js";
import { crossMacrotaskBoundary } from "./macrotask-boundary.test-support.js";

/**
 * Let every queued continuation reach React state, inside `act`.
 *
 * One microtask turn is not enough wherever an arrival settles an effect that
 * schedules the next one, which is every asynchronous read this console performs —
 * and a fixed number of turns is not enough either, which is why this crosses a
 * macrotask boundary instead of counting.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/**
 * A wait long enough to carry a debounced read past its window, derived once.
 *
 * Roughly twenty-five test sites restated this as the literal `500`. Raise
 * `REFRESH_DEBOUNCE_MS` and every one of them advances past nothing, the debounced
 * read never fires, and the cases fail naming a settlement rather than the constant
 * that moved. Derived here, they move with it.
 */
export const PAST_REFRESH_DEBOUNCE_MS: number = REFRESH_DEBOUNCE_MS * 2;
