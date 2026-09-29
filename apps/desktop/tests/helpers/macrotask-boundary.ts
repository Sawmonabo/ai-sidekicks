// The macrotask boundary a settling case waits on.
//
// A timing helper rather than a fixture one, so it sits on its own: the store, frame and
// bridge suites all wait on it.
//
// It arms a platform timer directly rather than through `Clock`, which shipped code
// may not do: a suite that has to let a real turn elapse cannot do it on a clock it also
// controls.
//
// Named for the boundary it arms: `setTimeout` waits for a macrotask. `settle.ts` waits on
// this boundary inside React's `act`, which is the one difference between the two.

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
