// The app's one `ResizeObserver` construction site, shared by the preview geometry, the
// session pane layout, the terminal, the overlay-registration hook and the scroll chokepoint's
// overflow measurement. Features never import each
// other, so `lib/` holds the one feature detection and teardown.

import { getWindow } from "@floating-ui/utils/dom";

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * Report every size change of one element until the returned disposer is called.
 *
 * A platform with no `ResizeObserver` arms nothing; the caller's other sources still fire, so
 * the reading is coarser, never wrong. The constructor is the element's own window's, read at arm
 * time: an observer reports only for the window it was made in, and a test's fake still reaches
 * every consumer.
 */
export function observeElementResize(element: Element, onResize: () => void): Unsubscribe {
  const ObserverConstructor = getWindow(element).ResizeObserver as
    | typeof ResizeObserver
    | undefined;
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
