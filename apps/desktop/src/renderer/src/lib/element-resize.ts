// The app's one `ResizeObserver` construction site, shared by the preview geometry, the
// session pane layout, the terminal, the overlay-registration hook, the scroll chokepoint's
// overflow measurement, a display formula's fit to its column and the flow diff's row steps.
// Features never import each other, so `lib/` holds the one feature detection and teardown.

import { getWindow } from "@floating-ui/utils/dom";

import type { Unsubscribe } from "#shared/preload-api.js";

/** One observer over a set of elements that changes while it runs. */
export interface ElementsResizeObservation {
  /** Report this element's size changes too, starting with its size now. */
  readonly observe: (element: Element) => void;
  /** Stop observing every element. */
  readonly disconnect: Unsubscribe;
}

/**
 * Report every size change of one element, with the observer's entries carrying its observed
 * boxes, until the returned disposer is called. The observer is made from the element's own
 * window, read at arm time: an observer reports only for the window it was made in, and a test's
 * fake still reaches every consumer.
 */
export function observeElementResize(
  element: Element,
  onResize: (entries: readonly ResizeObserverEntry[]) => void,
): Unsubscribe {
  const observation = observeElementsResize(getWindow(element), onResize);
  observation.observe(element);
  return observation.disconnect;
}

/**
 * Report every size change of any element handed to `observe`, through one observer made from
 * `ownerWindow`, until `disconnect` is called. A platform with no `ResizeObserver` arms nothing;
 * the caller's other sources still fire, so the reading is coarser, never wrong.
 */
export function observeElementsResize(
  ownerWindow: Window,
  onResize: (entries: readonly ResizeObserverEntry[]) => void,
): ElementsResizeObservation {
  const ObserverConstructor = (ownerWindow as Window & typeof globalThis).ResizeObserver as
    | typeof ResizeObserver
    | undefined;
  if (ObserverConstructor === undefined) {
    return { observe: () => undefined, disconnect: () => undefined };
  }
  const observer = new ObserverConstructor((entries) => {
    onResize(entries);
  });
  return {
    observe: (element) => {
      observer.observe(element);
    },
    disconnect: () => {
      observer.disconnect();
    },
  };
}
