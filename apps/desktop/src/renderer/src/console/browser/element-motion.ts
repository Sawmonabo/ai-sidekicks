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
//
// AND A MOVE IS NEITHER OF THOSE. `observeElementPosition` is the composed answer
// to "did this element change WHERE it is", which no single platform observer
// reports: a pane keeps its size and its animation state while a sibling shrinks,
// while the deck reorders around it, and while an ancestor is carried across the
// screen. Three sources cover those three ways, they share the one motion sampler
// below, and none of them samples at rest.

import type { ConsoleClock, ScheduledHandle, Unsubscribe } from "../core/index.js";

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

export interface MotionFrameSamplerOptions {
  readonly element: Element;
  /** The frame source. A real clock unless a test says otherwise. */
  readonly clock: ConsoleClock;
  /** Called once per frame while the element is moving, and once as it comes to rest. */
  readonly onFrame: () => void;
}

/**
 * Per-frame sampling of one moving element, armed by motion and disarmed by
 * stillness.
 *
 * A transition reports its START and its END and says nothing in between, so an
 * element being carried across the screen is only readable by looking once a frame
 * while it is in flight. THE LOOP DISARMS ITSELF: the frame that finds nothing
 * running is the last one, and it still reports — that report is where the element
 * came to rest, and dropping it would leave every consumer holding the second-to-last
 * position forever.
 *
 * A class rather than a function returning a disposer because two of its three
 * operations are questions about live state — is a frame armed, and may another be
 * armed — and `isSampling` is how the console's idle-CPU budget is checked here
 * rather than promised.
 */
export class MotionFrameSampler {
  readonly #element: Element;
  readonly #clock: ConsoleClock;
  readonly #onFrame: () => void;
  #queuedFrame: ScheduledHandle | undefined;

  public constructor(options: MotionFrameSamplerOptions) {
    this.#element = options.element;
    this.#clock = options.clock;
    this.#onFrame = options.onFrame;
  }

  /** Arm the next frame unless one is already armed. Idempotent. */
  public startIfIdle(): void {
    if (this.#queuedFrame !== undefined) {
      return;
    }
    this.#queuedFrame = this.#clock.scheduleFrame(() => {
      this.#runFrame();
    });
  }

  /** Whether a frame is armed right now. False at rest, and that is the budget. */
  public get isSampling(): boolean {
    return this.#queuedFrame !== undefined;
  }

  /** Drop any armed frame. Idempotent, and it never re-arms on its own. */
  public stop(): void {
    if (this.#queuedFrame === undefined) {
      return;
    }
    this.#clock.cancel(this.#queuedFrame);
    this.#queuedFrame = undefined;
  }

  #runFrame(): void {
    this.#queuedFrame = undefined;
    // Report BEFORE re-reading the animation state, so the frame that finds the
    // motion finished still reports the position the element came to rest at.
    this.#onFrame();
    if (hasRunningMotion(this.#element)) {
      this.startIfIdle();
    }
  }
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
 *   3. TRANSFORMS AND TRANSITIONS — motion starting anywhere that carries this
 *      element arms the shared frame sampler, which stops the moment nothing is
 *      running.
 *
 * THE ANCESTOR WALK STOPS AT THE DOCUMENT BODY. No console surface declares a
 * pane-deck root today, so the body is the outermost box whose reordering can move a
 * pane; the walk gains a tighter boundary in the edit that declares one, and until
 * then a walk that went further would only add the document element, which no layout
 * reorders.
 */
export function observeElementPosition(options: ElementPositionObserverOptions): Unsubscribe {
  const { element, clock, onMove } = options;
  const ancestors = readPositionAncestry(element);
  const detachers: Unsubscribe[] = [observeAncestorReorder(ancestors, onMove)];
  for (const ancestor of ancestors) {
    detachers.push(observeElementResize(ancestor, onMove));
  }
  const sampler = new MotionFrameSampler({ element, clock, onFrame: onMove });
  detachers.push(
    observeMotionStarts((movingNode) => {
      if (sharesMotionWith(element, movingNode)) {
        sampler.startIfIdle();
      }
    }),
    () => {
      sampler.stop();
    },
  );
  if (hasRunningMotion(element)) {
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

/** The Web Animations read, absent on a DOM shim that does not implement it. */
function readAnimations(element: Element, options?: GetAnimationsOptions): readonly Animation[] {
  return typeof element.getAnimations === "function" ? element.getAnimations(options) : [];
}

function isAnyRunning(animations: readonly Animation[]): boolean {
  return animations.some((animation) => animation.playState === "running");
}
