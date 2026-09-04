// The three ways a document says an element has moved, read in one place.
//
// `occlusion-registry.ts` holds WHICH overlays are on screen; this module holds how
// the document reports that one of them has moved. They are split because only this
// half needs a document: the registry stays testable over rectangle readers alone,
// and every DOM seam that can be absent — a shim with no Web Animations, a
// node-environment tier with no `document` — is guarded here once instead of at each
// use.
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
// THE SIZE SEAM ITSELF IS NOT HERE. `observeElementResize` was this family's, until
// the terminal family turned out to arm a size source too — for an emulator grid
// that re-fits when its host box changes — and the two families sit beside each
// other in the DAG, where neither can import the other. It lives in
// `primitives/element-resize.ts` now, which is the lowest family both sit above, and
// this module is one of its callers rather than its home.
//
// AND A MOVE IS NEITHER OF THOSE. `observeElementPosition` is the composed answer
// to "did this element change WHERE it is", which no single platform observer
// reports: a pane keeps its size and its animation state while a sibling shrinks,
// while the deck reorders around it, and while an ancestor is carried across the
// screen, and while a fixed-size box beside it is resized in one step by a class.
// Five sources cover those ways, they share the one motion sampler in
// `motion-sampling.ts`, and none of them samples at rest.

import type { ConsoleClock, Unsubscribe } from "../core/index.js";
import { observeElementResize } from "../primitives/index.js";
import { couldAnimationMove } from "./animation-motion.js";
import { MotionFrameSampler } from "./motion-sampling.js";

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
 *
 * FILTERED BY THE SAME BOUND AS THE DOCUMENT READING, and it used to be unfiltered.
 * The overlay registry arms its frame sampler on this predicate, so a `not-loaded`
 * skeleton inside a dialog or a popover — an infinite opacity pulse, which
 * `primitives/primitives.css` gives every read in flight — held it true for as long
 * as the read was out, and the sampler emitted an occlusion change on every animation
 * frame. That is the permanent RAF loop the document path already closed, reached
 * through the other door. Both doors now run `animation-motion.ts`'s one filter.
 *
 * The containment half is supplied and is not redundant even though every animation
 * this function reads is already on the element, inside it, or above it: an animation
 * whose effect names a DIFFERENT target than the node it was read from would
 * otherwise be judged on its flow alone, and the callback answers the question this
 * family answers everywhere else rather than a second version of it.
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
 * Whether ANYTHING in this document that could move this element is animating.
 *
 * The wide reading, for the subject whose position no containment test can bound: a
 * fixed-size sibling animating its width — a rail collapsing, a sidebar dragging —
 * moves the boxes beside it while neither it nor they change size and while nothing
 * containing either of them is animating at all. Asking "does this motion carry my
 * element" answers no for exactly that case, so a subject that cares about its
 * POSITION asks the document instead and measures the answer.
 *
 * WIDE IS NOT UNCONDITIONAL, and it used to be. `animation-motion.ts` states the two
 * bounds and why each is needed; what they buy here is that a loading skeleton's
 * infinite opacity pulse no longer holds this predicate true forever, which armed the
 * frame sampler on every frame for as long as anything on screen was loading.
 *
 * `document.getAnimations()` rather than a walk, because the document is where the
 * platform already holds the set; absent on a DOM shim, where the caller's
 * element-scoped reading still runs and the degrade is a coarser answer rather than
 * a wrong one.
 */
export function hasRunningDocumentMotion(element: Element): boolean {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") {
    return false;
  }
  const carriesSubject = (target: Element): boolean => sharesMotionWith(element, target);
  return isAnyMoving(document.getAnimations(), carriesSubject);
}

export interface ElementPositionObserverOptions {
  readonly element: Element;
  /** The frame source the transition arm samples on. */
  readonly clock: ConsoleClock;
  readonly onMove: () => void;
}

/**
 * Report every way this element's POSITION can change without its size changing,
 * until the returned disposer is called.
 *
 * A size observer on the element itself sees none of these, and each source covers
 * one of them:
 *
 *   1. REORDER — the element's ancestors are watched for `childList` changes, which
 *      is what a deck reordering its seats performs. Watching the element's own
 *      children would report its content changing and never its placement.
 *   2. SIBLING RESIZE — each of those same ancestors is watched for size. A sibling
 *      that shrinks moves this element while neither this element nor any ancestor
 *      changes size in the way a naive reading expects; what the platform reports is
 *      the ancestor's own content box being relaid, which is exactly this arm.
 *   3. TRANSFORMS AND TRANSITIONS — motion starting ANYWHERE in the document arms
 *      the shared frame sampler, which reads where this element actually is and
 *      stops the moment nothing is running.
 *   4. INSTANT RELAYOUT — every `class` and `style` change in the outermost
 *      ancestor's subtree. A width written in one step animates nothing, so source 3
 *      never arms; and where the box that changed is a FIXED-SIZE sibling of this
 *      element or of any ancestor, source 2 reports nothing either, because no
 *      watched box changed shape. The pane moved and no other source can say so.
 *   5. PROGRAMMATIC MOTION — every invalidation the four sources above raise also
 *      re-reads the animations, and arms the sampler when one is running.
 *
 * SOURCE 5 IS THE ONE WITH NO EVENT BEHIND IT, and that is the whole reason it
 * exists. `element.animate()` fires neither `transitionrun` nor `animationstart` —
 * both are CSS vocabularies — and a transform animation writes no class, no style
 * attribute, no size, and no child list, so sources 1 through 4 hear nothing and
 * source 3 never arms. A constant-size pane carried by the Web Animations API
 * therefore left the native view at coordinates it had abandoned, for the whole
 * animation, and nothing in this module could say so.
 *
 * SO THE READ IS THE REGISTRATION, AND IT IS BOUNDED. There is no event for "an
 * animation was created", and `document.getAnimations()` on a timer is a poll this
 * console does not run. What is left is to look at the moments this module is awake
 * ALREADY: once when the observation is installed, and once per invalidation any
 * other source raises. That is at most one animation read per invalidation, no timer,
 * and nothing whatever at rest — the same reading `isMotionRunning` takes, at a
 * moment the module was going to run code anyway.
 *
 * The bound is stated rather than hidden: an animation that starts while every other
 * source is silent is picked up at the next invalidation and not before. In practice
 * a surface that animates a box also toggles the class or style that decided to,
 * which is source 4 in the same delivery turn. THE DISARM IS NOT PAIRED WITH THIS
 * ARM — the sampler re-reads the same animations on every frame and stops on the one
 * that finds nothing running, which is where the element came to rest. An
 * `Animation.finished` listener beside it would be a second authority over a decision
 * the loop already owns.
 *
 * A CONSOLE-STARTED ANIMATION WOULD REGISTER ITSELF rather than wait to be found, and
 * no hook for that is minted here: the console starts none. `.animate(` matches no
 * console module today, so a registration function would be an export with no caller,
 * which the dead-code gate rejects and `apps/desktop/AGENTS.md` calls a symbol minted
 * ahead of its reader. The console's own motion is CSS-driven, which source 3 hears.
 *
 * SOURCE 3 DELIBERATELY DOES NOT ASK WHETHER THE MOTION CARRIES THIS ELEMENT. The
 * containment test the overlay registry uses answers "no" for the case this observer
 * exists for: a fixed-size flex or grid sibling animating its width is neither an
 * ancestor nor a descendant, and it moves this element while every box involved —
 * this one, the sibling, and the container holding both — keeps the size it had. No
 * resize callback fires, no containment test matches, and the native view stays at
 * coordinates the pane left. So the arm is a POSITION measurement rather than a
 * prediction: while anything animates, look; the reading itself decides whether
 * anything moved, and the publisher above already drops a rectangle that did not
 * change. What that costs is a frame read per animating frame, and what it buys is
 * the one class of movement nothing else in this module can see.
 *
 * THE ANCESTOR WALK STOPS AT THE DOCUMENT BODY. No console surface declares a
 * pane-deck root today, so the body is the outermost box whose reordering can move a
 * pane; the walk gains a tighter boundary in the edit that declares one, and until
 * then a walk that went further would only add the document element, which no layout
 * reorders.
 */
export function observeElementPosition(options: ElementPositionObserverOptions): Unsubscribe {
  const { element, clock, onMove } = options;
  // The document reading covers the element's own subtree and ancestors wherever the
  // platform implements it; the element-scoped one is what a DOM shim that omits
  // `document.getAnimations` still answers, so neither is redundant.
  const isMotionRunning = (): boolean =>
    hasRunningDocumentMotion(element) || hasRunningMotion(element);
  const sampler = new MotionFrameSampler({ isMotionRunning, clock, onFrame: onMove });
  /**
   * Source 5, folded into the other four rather than armed beside them.
   *
   * Every invalidation is a moment this module runs code, so it is a free place to
   * ask whether an animation nothing announced is carrying the element — and the ask
   * is one read of the same animations the sampler's own loop takes. Reporting comes
   * after arming so the caller's reading and the loop's first frame describe the same
   * instant.
   */
  const noteInvalidation = (): void => {
    if (isMotionRunning()) {
      sampler.startIfIdle();
    }
    onMove();
  };
  const ancestors = readPositionAncestry(element);
  const detachers: Unsubscribe[] = [
    observeAncestorReorder(ancestors, noteInvalidation),
    observeLayoutAttributes(ancestors, noteInvalidation),
  ];
  for (const ancestor of ancestors) {
    detachers.push(observeElementResize(ancestor, noteInvalidation));
  }
  detachers.push(
    observeMotionStarts(() => {
      sampler.startIfIdle();
    }),
    () => {
      sampler.stop();
    },
  );
  if (isMotionRunning()) {
    // Observed mid-animation — the case a start event has already been and gone for.
    sampler.startIfIdle();
  }
  return () => {
    for (const detach of detachers) {
      detach();
    }
  };
}

/** Every ancestor whose relayout can move this element, innermost first. */
function readPositionAncestry(element: Element): readonly Element[] {
  const boundary = typeof document === "undefined" ? null : document.body;
  const ancestors: Element[] = [];
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestors.push(ancestor);
    if (ancestor === boundary) {
      return ancestors;
    }
  }
  return ancestors;
}

/**
 * Watch one `MutationObserver` over every ancestor's child list.
 *
 * One observer with many targets rather than one per ancestor, because a
 * `MutationObserver` takes targets and a `ResizeObserver` callback would not tell
 * the caller anything more here: every one of these mutations means the same thing.
 */
function observeAncestorReorder(ancestors: readonly Element[], onReorder: () => void): Unsubscribe {
  if (typeof MutationObserver === "undefined" || ancestors.length === 0) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    onReorder();
  });
  for (const ancestor of ancestors) {
    observer.observe(ancestor, { childList: true });
  }
  return () => {
    observer.disconnect();
  };
}

/**
 * The attributes an INSTANT layout change arrives on.
 *
 * `class` and `style`, and nothing else: those are the two a script writes a box's
 * width through without animating it. A filter of two is also what keeps a
 * document-wide watch from waking on every `aria-expanded`, every `data-` flag, and
 * every `value` the console writes — mutations that move no box at all.
 */
const LAYOUT_ATTRIBUTE_NAMES = ["class", "style"] as const;

/**
 * Watch every `class` and `style` change in the outermost ancestor's subtree.
 *
 * WHY A SECOND OBSERVER RATHER THAN A WIDER OPTION SET ON THE FIRST. A
 * `MutationObserver`'s registration is per node, and a second `observe()` call on a
 * node REPLACES the options the first gave it — so folding `attributes` into the
 * reorder watch means the two questions share one width. Either the attribute arm
 * inherits `subtree: false` and sees no sibling's attribute at all, which is the
 * whole case; or the reorder arm inherits `subtree: true` and fires on every node
 * inserted anywhere in the document, which on a console with a live feed is a
 * forced layout per appended row. Two observers keep each question at the width it
 * needs.
 *
 * WHY THE OUTERMOST ANCESTOR AND NOT EACH OF THEM. The box that moved this element
 * can sit beside ANY ancestor, not only beside the element: a fixed-size sibling of
 * the deck moves the pane exactly as a fixed-size sibling of the pane does, and a
 * subtree rooted at the innermost ancestor contains neither. The outermost ancestor
 * is the one subtree that holds every one of them, and registering the inner ones
 * as well would queue duplicate records for one mutation without covering one more
 * node.
 *
 * WHAT COALESCES A BURST. A `MutationObserver` delivers ONE callback per delivery
 * turn carrying every record queued during it, so fifty class writes in one turn
 * reach `onLayoutAttributeChange` once. The publisher above then takes one reading
 * per call and queues one frame for the write. Nothing on this path reads a layout
 * per mutation, and nothing here reads one at all.
 */
function observeLayoutAttributes(
  ancestors: readonly Element[],
  onLayoutAttributeChange: () => void,
): Unsubscribe {
  const outermostAncestor = ancestors.at(-1);
  if (typeof MutationObserver === "undefined" || outermostAncestor === undefined) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    onLayoutAttributeChange();
  });
  observer.observe(outermostAncestor, {
    attributes: true,
    attributeFilter: [...LAYOUT_ATTRIBUTE_NAMES],
    subtree: true,
  });
  return () => {
    observer.disconnect();
  };
}

/** The Web Animations read, absent on a DOM shim that does not implement it. */
function readAnimations(element: Element, options?: GetAnimationsOptions): readonly Animation[] {
  return typeof element.getAnimations === "function" ? element.getAnimations(options) : [];
}

/**
 * Whether any of these animations is running AND could move the caller's subject.
 *
 * The one filter both readings run, rather than a play-state check on one path and a
 * discriminated one on the other: the two answers are the same question asked of a
 * different animation set, and the moment they are written twice one of them keeps
 * arming a frame loop over a loading skeleton.
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
