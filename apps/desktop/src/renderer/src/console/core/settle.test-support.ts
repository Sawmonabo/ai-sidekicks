// The one act-wrapped microtask settle, and the one derived debounce bound.
//
// Nine suites wrote this loop, differing only in the bound they passed (3, 3, 3, 4,
// 4, 4, 6, 8) and in nothing else — same `act`, same `Promise.resolve()`, same
// shape. A loop written nine times is a loop fixed once: a surface that grows one
// more chained effect gets its own copy raised, and the eight that flush one pass
// too few then assert against a tree one settlement behind, intermittently, because
// the short count wins on a fast machine.
//
// THE BOUND STAYS WITH THE CALLER. It is the depth of that surface's own effect
// chain — a property of the surface and not of the loop — so it is an argument here
// rather than a constant. What is shared is the mechanism: `act` around a resolved
// promise, so React flushes the effects each pass schedules before the next runs.
//
// It lives in `core/` for the reason `frozen-instant.test-support.ts` does: it is
// the bottom of the family DAG, so a view family, a store suite, and a settings page
// all reach it without one of them having to import another's family.

import { act } from "@testing-library/react";

import { REFRESH_DEBOUNCE_MS } from "./constants.js";

/**
 * Let `passes` rounds of queued continuations land, flushing effects between them.
 *
 * One pass is not enough wherever an arrival settles an effect that schedules the
 * next one, which is every asynchronous read this console performs.
 */
export async function settle(passes: number): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
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
