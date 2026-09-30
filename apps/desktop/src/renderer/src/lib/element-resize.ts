// The console's one `ResizeObserver` construction site, shared by the preview geometry, the
// session pane layout, the terminal and the overlay-registration hook. Features never import each
// other, so `lib/` holds the one feature detection and teardown.

import type { Unsubscribe } from "./emitter.js";

/**
 * Report every size change of one element until the returned disposer is called.
 *
 * A platform with no `ResizeObserver` arms nothing; the caller's other sources still fire, so
 * the reading is coarser, never wrong. The constructor is read from `globalThis` at arm time so
 * a test's fake reaches every consumer.
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
