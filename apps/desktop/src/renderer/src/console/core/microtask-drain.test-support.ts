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

/**
 * Let every pending microtask chain run.
 *
 * A macrotask boundary rather than a counted number of `await`s: the old behaviour
 * settled a delayed reply two or three microtasks deep, so a count would have to be
 * tuned against the implementation it is meant to hold.
 */
export function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
