// Letting queued work reach React state, inside React's own scope — once, for the
// whole console.
//
// The four-line `act(async () => { await Promise.resolve(); })` was authored six times
// across three families: the frame's route-surface support module, three of its
// suites, and one suite each in `browser/` and `terminal/`. They agreed by accident,
// and a helper that agrees by accident is one that stops agreeing the first time
// anybody learns something — which had already happened twice in `frame/`, where one
// suite needed two microtask turns and another needed a macrotask because happy-dom
// raises `hashchange` on a task of its own.
//
// IT LIVES IN `primitives/` BECAUSE OF WHO NEEDS IT. The consumers span view families,
// and a view family never imports another; the frame is above them, so its module
// could not be the home either. `primitives/` is the lowest family every consumer sits
// above, which is what this package's hoisting rule names as the home — and the only
// other candidate, `test/console/`, is unreachable from a co-located suite, since
// `src/renderer/tsconfig.test.json` roots at `apps/desktop/src` and an import out of
// the package's `test/` tree is a TS6059 rather than a style question.
//
// THE TURN COUNT IS A PARAMETER AND THE MACROTASK IS NOT. One turn and two turns are
// the same act with a different depth of continuation, so a caller that needs the
// deeper one says so. A macrotask is a different scheduling claim about a different
// producer — the DOM implementation, not a promise chain — and folding it in behind a
// flag would let a caller ask for "settled" and get a wait whose reason it never
// stated. That one stays where its reason is written down.

import { act } from "@testing-library/react";

/**
 * Let queued continuations reach React state, inside `act`.
 *
 * `act` rather than a bare flush: a state write raised from a promise callback outside
 * React's scope is applied without the surrounding commit, so an assertion taken next
 * reads the render before it and the suite reports a hook that never moved.
 *
 * `microtaskTurns` is how many continuations deep the caller's own chain runs — one
 * for a hook settling a single awaited call, more where a settlement is itself awaited
 * before the state write it causes.
 */
export async function settleReactWork(microtaskTurns: number = 1): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < microtaskTurns; turn += 1) {
      await Promise.resolve();
    }
  });
}
