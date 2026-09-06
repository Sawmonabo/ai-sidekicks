// The console's one `ResizeObserver` construction site.
//
// Two families arm a size source: `browser/` — the overlay registry and the pane
// geometry publisher — and `terminal/`, whose emulator re-fits its grid when the
// host box changes. They sit at the same level of the console's DAG, so neither can
// import the other's copy, and each writing its own was two feature detections and
// two teardowns for one seam. `apps/desktop/AGENTS.md` calls that hoist-on-second-
// use, and `primitives/` is the lowest family both consumers sit above.
//
// ITS OWN LEAF MODULE, for `chord-format.ts`'s reason: a primitive never imports
// upward, and this one imports a single type from the DAG floor and nothing else. It
// renders nothing and holds no state, so it is a `.ts` module beside the components
// rather than one of them.

import type { Unsubscribe } from "../core/index.js";

/**
 * Report every size change of one element until the returned disposer is called.
 *
 * A platform with no `ResizeObserver` arms nothing and says so by doing nothing: the
 * caller's other sources still fire, which is the honest degrade — a missing observer
 * makes the reading coarser, never wrong.
 *
 * The constructor is read off `globalThis` at ARM time rather than closed over at
 * module load, so a caller that arms after the platform supplied one gets it, and a
 * suite that installs a fake reaches every consumer through this one read.
 */
export function observeElementResize(element: Element, onResize: () => void): Unsubscribe {
  const ObserverConstructor = globalThis.ResizeObserver as typeof ResizeObserver | undefined;
  if (ObserverConstructor === undefined) {
    return () => undefined;
  }
  const observer = new ObserverConstructor(() => {
    onResize();
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
}
