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
// IT LIVES IN `core/` BECAUSE OF WHO NEEDS IT. The consumers span view families, and a
// view family never imports another; the frame is above them, so its module could not
// be the home either. `core/` is the DAG floor and therefore the lowest family every
// consumer sits above, which is what this package's hoisting rule names as the home —
// and the only other candidate, `test/console/`, is unreachable from a co-located
// suite, since `src/renderer/tsconfig.test.json` roots at `apps/desktop/src` and an
// import out of the package's `test/` tree is a TS6059 rather than a style question.
//
// It sat in `primitives/` on the same rule read one family too high, which was true
// when it landed and stopped being true in the same substrate that put the settle
// boundary's sibling at `core/macrotask-boundary.test-support.ts` — one role split
// across two layer families, the higher one justified by a sentence the tree had
// already contradicted. `core/committed-frame.test-support.tsx` is the precedent that
// this family may hold a React-importing test-support module.
//
// THE SETTLE IS A BOUNDARY AND NOT A COUNT, which is a correction rather than the
// shape this landed in. It took a `microtaskTurns` parameter, and the number was
// tuned against whatever promise chain the calling case happened to be written over:
// a reply that grows one link deeper stops being waited for, and the case then
// reports the ABSENCE of an answer that was merely still in flight — silent in
// exactly the direction that matters, which is why
// `test/console/architecture/act-settling.test.ts` forbids the counted form inside an
// `act` body. So the wait is now the one its sibling
// `core/macrotask-boundary.test-support.ts` arms, and the two helpers are one
// vocabulary with one difference between them: whether the wait happens inside
// React's scope.

import { act } from "@testing-library/react";

import { crossMacrotaskBoundary } from "./macrotask-boundary.test-support.js";

/**
 * Let queued continuations reach React state, inside `act`.
 *
 * `act` rather than a bare flush: a state write raised from a promise callback outside
 * React's scope is applied without the surrounding commit, so an assertion taken next
 * reads the render before it and the suite reports a hook that never moved.
 *
 * `crossMacrotaskBoundary` rather than a counted number of continuations: the boundary
 * drains every pending microtask chain on the way across, so a case whose settlement
 * is itself awaited before the state write it causes waits correctly without saying
 * how deep its own chain runs.
 */
export async function settleReactWork(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}
