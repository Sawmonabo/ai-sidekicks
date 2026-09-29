// The console's one `ResizeObserver` construction site.
//
// Several features arm a size source — the preview's geometry publisher, the session
// pane layout, and the terminal, whose emulator re-fits its grid when its box changes —
// and so does the overlay-registration hook. One feature never imports another, so
// each writing its own would be one feature detection and one teardown per copy for a
// single seam; `lib/` is the one layer every consumer sits above.
//
// ITS OWN LEAF MODULE: shared code never imports upward, and this one imports a single
// type from `emitter.ts` and nothing else. It renders nothing and holds no state, so it
// is a plain `.ts` module rather than a component.

import type { Unsubscribe } from "./emitter.js";

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
