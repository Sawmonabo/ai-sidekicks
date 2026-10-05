// Document seams for "did this element move": motion-start events, running animations and the
// composed position observer. A ResizeObserver says nothing about a box carried at constant
// size, so motion is its own seam, caught at the document because `transitionrun` and
// `animationstart` bubble upward and an ancestor's motion would go unheard on the element.

import { isNode } from "@floating-ui/utils/dom";

import type { Clock } from "@renderer/lib/clock.js";
import type { Unsubscribe } from "@shared/preload-api.js";
import { observeElementResize } from "@renderer/lib/element-resize.js";
import { couldAnimationMove } from "./animation-motion.js";
import { MotionFrameSampler } from "./motion-sampling.js";
import {
  observeAncestorReorder,
  observeLayoutAttributes,
  readAncestrySiblings,
  readPositionAncestry,
  SiblingSizeObservers,
} from "./position-ancestry.js";

/**
 * The events that announce motion starting. `transitionrun` fires at the start of the delay
 * phase, so a delayed transition is not missed; motion stops are read off the animations.
 */
const MOTION_START_EVENT_NAMES = ["transitionrun", "animationstart"] as const;

/** What `observeElementPosition` watches and where it reports. */
export interface ElementPositionObserverOptions {
  readonly element: Element;
  /** The frame source the transition arm samples on. */
  readonly clock: Clock;
  readonly onMove: () => void;
}

/** Reports the node under every transition or animation that starts in `ownerDocument`. */
export function observeMotionStarts(
  ownerDocument: Document,
  onMotionStart: (movingNode: Node) => void,
): Unsubscribe {
  const handleMotionStart = (event: Event): void => {
    const movingNode = event.target;
    if (isNode(movingNode)) {
      onMotionStart(movingNode);
    }
  };
  for (const eventName of MOTION_START_EVENT_NAMES) {
    ownerDocument.addEventListener(eventName, handleMotionStart, { capture: true });
  }
  return () => {
    for (const eventName of MOTION_START_EVENT_NAMES) {
      ownerDocument.removeEventListener(eventName, handleMotionStart, { capture: true });
    }
  };
}

/**
 * Whether motion on `movingNode` carries `element`: the node is the element, inside it, or
 * contains it. A sibling's animation moves nothing here.
 */
export function sharesMotionWith(element: Element, movingNode: Node): boolean {
  return element.contains(movingNode) || movingNode.contains(element);
}

/**
 * Whether anything that could be moving this element is running now: its own subtree and every
 * ancestor up to the document root (an ancestor's collapse is what moves an overlay). Animations
 * pass the filter in `animation-motion.ts`, so a loading skeleton's pulse does not count. The
 * containment callback still matters: an animation whose effect targets another node than the one
 * it was read from would otherwise be judged on flow alone.
 */
export function hasRunningMotion(element: Element): boolean {
  const carriesSubject = (target: Element): boolean => sharesMotionWith(element, target);
  if (isAnyMoving(readAnimations(element, { subtree: true }), carriesSubject)) {
    return true;
  }
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (isAnyMoving(readAnimations(ancestor), carriesSubject)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether anything in the element's document that could move it is animating: the wide reading
 * for a subject whose position no containment test bounds (a fixed-size sibling animating its
 * width moves the boxes beside it while nothing containing either animates). False on a DOM
 * shim without `document.getAnimations`; the element-scoped reading still runs.
 */
export function hasRunningDocumentMotion(element: Element): boolean {
  const ownerDocument = element.ownerDocument;
  if (typeof ownerDocument.getAnimations !== "function") {
    return false;
  }
  const carriesSubject = (target: Element): boolean => sharesMotionWith(element, target);
  return isAnyMoving(ownerDocument.getAnimations(), carriesSubject);
}

/**
 * Reports every way this element's position can change without its size changing, until the
 * returned disposer is called. Six sources feed one invalidation:
 * 1. ancestor `childList` changes (a pane layout reordering its panes);
 * 2. ancestor resizes (a shrinking sibling relays the ancestor's content box);
 * 3. motion starting anywhere in the document, which arms the shared frame sampler. It does not
 *    ask whether the motion carries this element: a fixed-size sibling animating its width
 *    moves it while no containment test matches;
 * 4. `class`/`style` changes in the outermost ancestor's subtree (an instant width write
 *    animates nothing, so source 3 never arms);
 * 5. running animations, re-read on every invalidation because `element.animate()` fires no CSS
 *    event. No timer runs, and an animation starting while all sources are silent is found at
 *    the next invalidation. The sampler disarms itself, so no `Animation.finished` is paired;
 * 6. size observers over siblings of the element and its ancestors (see `position-ancestry.ts`),
 *    re-derived when source 1 fires. A move to a different parent is a resubscribe for the owner.
 */
export function observeElementPosition(options: ElementPositionObserverOptions): Unsubscribe {
  const { element, clock, onMove } = options;
  // The document reading covers the subtree and ancestors where the platform implements it; the
  // element-scoped one answers on a DOM shim without `document.getAnimations`.
  const isMotionRunning = (): boolean =>
    hasRunningDocumentMotion(element) || hasRunningMotion(element);
  const sampler = new MotionFrameSampler({ isMotionRunning, clock, onFrame: onMove });
  // Source 5: every invalidation also asks whether an unannounced animation is carrying the
  // element. It reports after arming, so the caller's reading and the loop's first frame
  // describe the same instant.
  const noteInvalidation = (): void => {
    if (isMotionRunning()) {
      sampler.startIfIdle();
    }
    onMove();
  };
  const ancestors = readPositionAncestry(element);
  const siblingSizes = new SiblingSizeObservers(noteInvalidation);
  siblingSizes.watch(readAncestrySiblings(element, ancestors));
  const detachers: Unsubscribe[] = [
    observeAncestorReorder(ancestors, () => {
      // Re-derive the sibling set first: a reorder can add the box whose growth comes next.
      siblingSizes.watch(readAncestrySiblings(element, ancestors));
      noteInvalidation();
    }),
    observeLayoutAttributes(ancestors, noteInvalidation),
    () => {
      siblingSizes.dispose();
    },
  ];
  for (const ancestor of ancestors) {
    detachers.push(observeElementResize(ancestor, noteInvalidation));
  }
  detachers.push(
    observeMotionStarts(element.ownerDocument, () => {
      sampler.startIfIdle();
    }),
    () => {
      sampler.stop();
    },
  );
  if (isMotionRunning()) {
    // Observed mid-animation: the start event has already come and gone.
    sampler.startIfIdle();
  }
  return () => {
    for (const detach of detachers) {
      detach();
    }
  };
}

/** The Web Animations read, absent on a DOM shim that does not implement it. */
function readAnimations(element: Element, options?: GetAnimationsOptions): readonly Animation[] {
  return typeof element.getAnimations === "function" ? element.getAnimations(options) : [];
}

/**
 * Whether any of these animations is running and could move the caller's subject; the one
 * filter both readings share.
 */
function isAnyMoving(
  animations: readonly Animation[],
  carriesSubject: (target: Element) => boolean,
): boolean {
  return animations.some(
    (animation) =>
      animation.playState === "running" && couldAnimationMove(animation, carriesSubject),
  );
}
