// The app's one `ResizeObserver` construction site, shared by the preview geometry, the
// session pane layout, the terminal, the overlay-registration hook, the scroll chokepoint's
// overflow measurement, a call output's cut and the display formulas' fit to their columns.
// Features never import each other, so `lib/` holds the one feature detection and teardown.

import { getWindow } from "@floating-ui/utils/dom";

import type { Unsubscribe } from "#shared/preload-api.js";

/** One observer over many elements of one window. */
export interface ElementResizeWatch {
  observe(element: Element): void;
  unobserve(element: Element): void;
  /** Stops watching every element. */
  disconnect(): void;
}

/**
 * Watches the elements given it in `view`, reporting each delivery's entries in one call, so a
 * caller reads every element reported before it writes to any.
 *
 * A platform with no `ResizeObserver` watches nothing; the caller's other sources still fire, so
 * the reading is coarser, never wrong. The constructor is the window's own: an observer reports
 * only for the window it was made in, and a test's fake still reaches every consumer.
 */
export function watchElementsResize(
  view: Window & typeof globalThis,
  onResize: (entries: readonly ResizeObserverEntry[]) => void,
): ElementResizeWatch {
  const ObserverConstructor = view.ResizeObserver as typeof ResizeObserver | undefined;
  if (ObserverConstructor === undefined) {
    return { observe: () => undefined, unobserve: () => undefined, disconnect: () => undefined };
  }
  return new ObserverConstructor((entries) => {
    onResize(entries);
  });
}

/**
 * Report every size change of one element, with the observer's entries carrying its observed
 * boxes, until the returned disposer is called. The observer is the element's own window's, read
 * at arm time.
 */
export function observeElementResize(
  element: Element,
  onResize: (entries: readonly ResizeObserverEntry[]) => void,
): Unsubscribe {
  const watch = watchElementsResize(getWindow(element), onResize);
  watch.observe(element);
  return () => {
    watch.disconnect();
  };
}
