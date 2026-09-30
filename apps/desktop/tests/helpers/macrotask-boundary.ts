// The macrotask boundary a settling case waits on, shared by the store, frame and bridge suites.
//
// It arms a platform timer directly rather than through `Clock`, which shipped code may not: a
// suite letting a real turn elapse cannot do it on a clock it also controls. `settle.ts` waits on
// this boundary inside React's `act`.

/**
 * Wait until the platform has run a task of its own.
 *
 * A macrotask boundary, not a counted number of `await`s: the producers these cases wait on are
 * the DOM implementation's (happy-dom raises `hashchange` on its own task), so a count would be
 * tuned against the implementation. Crossing it drains every pending microtask chain on the way.
 */
export function crossMacrotaskBoundary(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
