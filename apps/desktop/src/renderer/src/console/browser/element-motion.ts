// The three ways a document says an element has moved, read in one place.
//
// `occlusion-registry.ts` holds WHICH overlays are on screen; this module holds how
// the document reports that one of them has moved. They are split because only this
// half needs a document: the registry stays testable over rectangle readers alone,
// and every DOM seam that can be absent — a platform with no `ResizeObserver`, a
// shim with no Web Animations, a node-environment tier with no `document` — is
// guarded here once instead of at each use.
//
// A SIZE CHANGE AND A MOTION ARE DIFFERENT FACTS. A `ResizeObserver` fires when the
// box changes shape and says nothing about a box that is being carried across the
// screen at a constant size, which is what a slide-in transition does. So the two
// are separate seams and an overlay arms both.
//
// WHY MOTION IS CAPTURED AT THE DOCUMENT. `transitionrun` and `animationstart`
// bubble UPWARD, so a listener on the overlay hears its own and its descendants'
// motion and never an ancestor's — and an ancestor is the case that matters most,
// because a rail that collapses or a sheet that slides carries every overlay inside
// it. One capture-phase pair on the document hears all three, and the caller
// decides which of its subjects the moving node belongs to.
//
// ONE CONSTRUCTION SITE PER SEAM. Both consumers — the overlay registry and the
// pane geometry publisher — arm their size source through `observeElementResize`
// here rather than constructing an observer of their own, so the feature detection
// and the disconnect-on-dispose cannot drift apart between them.

import type { Unsubscribe } from "../core/index.js";

/**
 * The two events that announce motion STARTING.
 *
 * `transitionrun` rather than `transitionstart` because it fires at the beginning of
 * the delay phase, and a transition with a delay has already been committed by then
 * — waiting for `transitionstart` would leave the overlay's first movement unsampled.
 * `animationend` and friends are deliberately absent: motion STOPS are read off the
 * animations themselves, so a caller never has to reconcile two vocabularies.
 */
const MOTION_START_EVENT_NAMES = ["transitionrun", "animationstart"] as const;

/**
 * Report every size change of one element until the returned disposer is called.
 *
 * A platform with no `ResizeObserver` arms nothing and says so by doing nothing: the
 * caller's other sources still fire, which is the honest degrade — a missing observer
 * makes the reading coarser, never wrong.
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

/**
 * Report the node under every transition or animation that starts anywhere in this
 * document. One listener pair serves every subject a caller holds — a pair per
 * subject would be the same handler registered N times for one event.
 */
export function observeMotionStarts(onMotionStart: (movingNode: Node) => void): Unsubscribe {
  if (typeof document === "undefined") {
    return () => undefined;
  }
  const handleMotionStart = (event: Event): void => {
    const movingNode = event.target;
    if (movingNode instanceof Node) {
      onMotionStart(movingNode);
    }
  };
  for (const eventName of MOTION_START_EVENT_NAMES) {
    document.addEventListener(eventName, handleMotionStart, { capture: true });
  }
  return () => {
    for (const eventName of MOTION_START_EVENT_NAMES) {
      document.removeEventListener(eventName, handleMotionStart, { capture: true });
    }
  };
}

/**
 * Whether motion on `movingNode` carries `element` with it.
 *
 * True in all three directions that matter and only those: the node IS the element,
 * the node is inside it (a descendant that reflows it), or the element is inside the
 * node (an ancestor that transports it). A sibling's animation moves nothing here.
 */
export function sharesMotionWith(element: Element, movingNode: Node): boolean {
  return element.contains(movingNode) || movingNode.contains(element);
}

/**
 * Whether anything that could be moving this element is running right now.
 *
 * The element's own subtree comes from one `getAnimations({ subtree: true })` call;
 * the ancestors are walked to the document root, because the registry holds no
 * reference to any container that would bound the walk and an ancestor that stops the
 * walk early is exactly the one whose collapse moved the overlay. The walk only runs
 * while something is already known to be animating or has just started, so it costs
 * nothing at rest.
 */
export function hasRunningMotion(element: Element): boolean {
  if (isAnyRunning(readAnimations(element, { subtree: true }))) {
    return true;
  }
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (isAnyRunning(readAnimations(ancestor))) {
      return true;
    }
  }
  return false;
}

/** The Web Animations read, absent on a DOM shim that does not implement it. */
function readAnimations(element: Element, options?: GetAnimationsOptions): readonly Animation[] {
  return typeof element.getAnimations === "function" ? element.getAnimations(options) : [];
}

function isAnyRunning(animations: readonly Animation[]): boolean {
  return animations.some((animation) => animation.playState === "running");
}
