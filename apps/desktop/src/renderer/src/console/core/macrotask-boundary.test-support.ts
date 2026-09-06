// The macrotask boundary a settling case waits on, at the bottom of the family DAG.
//
// A TIMING HELPER, WHICH IS WHY IT IS HERE. It lived beside the fixture bridge
// because the first suites that needed it were that family's, and the name a module
// is first written next to is not its home: `store/`, `frame/` and `bridge/` all
// wait on this boundary, and the two lower families reaching into `bridge/` for it
// is an upward edge on the console's own DAG. `core/` is the lowest family every one
// of them may reach, and it is where the clock seam already lives — this is the
// clock's test-tier sibling, not the fixture's.
//
// It arms a platform timer directly rather than through `ConsoleClock`, which is the
// one thing a console module may not do. That is legal here for the reason the timer
// chokepoint's own header records: its walk excludes `.test-support.*`, because a
// suite that has to let a real turn elapse cannot do it on a clock it also controls.
//
// AND IT IS NAMED FOR THE BOUNDARY IT ARMS. It was `drainMicrotasks`, in
// `microtask-drain.test-support.ts`, which is the opposite of what `setTimeout` waits
// for — and one suite imports it beside `settleReactWork`, which then really was a
// counted number of microtask turns, so the two helpers' names were each the other's
// meaning one line apart and repairing either in the obvious direction broke a suite.
// That helper waits on this boundary now, inside React's scope, and the naming is what
// kept the two legible to each other while one of them still counted turns.

/**
 * Wait until the platform has run a task of its own.
 *
 * A macrotask boundary rather than a counted number of `await`s: the producers these
 * cases wait on are the DOM implementation's — happy-dom raises `hashchange` on its
 * own task, and a delayed fixture reply settles two or three microtasks deep — so a
 * count would have to be tuned against the implementation it is meant to hold.
 * Crossing the boundary drains every pending microtask chain on the way, which is why
 * it also serves the cases that only need those.
 */
export function crossMacrotaskBoundary(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
