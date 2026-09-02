// The overlay set the native view yields to.
//
// `Spec-023 §Console Design (Meridian)` 12.3: "Every overlay primitive registers its
// own rectangle on mount … The visibility predicate consults the registry, and an
// overlay whose rectangle intersects the pane makes the view yield. Registration
// happens once, at the primitive layer, never per overlay instance." The wire table
// for the same surface reads `renderer-local`, and this module is that locality.
//
// AN OVERLAY MOVES AFTER IT REGISTERS, AND THE VIEW HAS TO FOLLOW. Opening and
// closing are not the only moments a rectangle changes: a popover is positioned
// AFTER it mounts, a dialog animates in, a toast grows as its text wraps, a rail
// collapse carries everything inside it. A registry that emitted only on register and
// remove would leave the native view painted over the overlay until some unrelated
// scroll, resize, or theme change happened to re-sample. So three movement sources
// sit beside the two lifecycle ones, and all five emit through the SAME change path
// the publisher already re-samples on:
//
//   1. EXPLICIT — the handle's `moved()`, called by positioning code that has just
//      computed a rectangle. The only source that needs no element at all.
//   2. SIZE — a `ResizeObserver` on the registered element, disconnected on remove.
//   3. MOTION — while a transition or animation on the element, a descendant, or an
//      ancestor is running, one sample per animation frame, stopping on the first
//      frame that finds nothing running. That last frame is the one that publishes
//      where the overlay came to rest.
//
// NOTHING SAMPLES AT REST. The console's budgets forbid idle CPU, so there is no
// standing frame loop: source 3 is armed by a motion START and by a registration that
// arrives mid-animation, and it disarms itself. `samplingOverlayCount` is how that is
// checked rather than asserted.
//
// Sources 2 and 3 need an element; source 1 does not, so `element` is optional and an
// overlay that supplies none still reports its own movement through `moved()`.
//
// WHERE THIS WILL EVENTUALLY LIVE. `primitives/` sits BELOW this family in the
// console's DAG, so an overlay primitive cannot import this module: the registry is
// hoisted into `core/` by the task that adds the first overlay primitive, and its
// consumers move with it. It is minted here because this is the surface that reads
// it, and a registry nobody can reach is a plan rather than a seam.

import {
  Emitter,
  RealClock,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../core/index.js";
import {
  hasRunningMotion,
  observeElementResize,
  observeMotionStarts,
  sharesMotionWith,
} from "./element-motion.js";
import type { PaneOverlaySource, PaneRect } from "./pane-geometry.js";

/** One overlay's live rectangle, read at the moment the predicate asks. */
export type OverlayRectReader = () => PaneRect | undefined;

/**
 * The overlay kinds 12.3 enumerates. Closed, and the enumeration is the claim: a new
 * overlay primitive joins this tuple in the edit that makes it register.
 */
export const OVERLAY_KINDS = [
  "dialog",
  "popover",
  "context-menu",
  "toast",
  "command-palette",
  "image-lightbox",
  "diagram-lightbox",
] as const;

export type OverlayKind = (typeof OVERLAY_KINDS)[number];

/**
 * What a registered overlay holds.
 *
 * An object rather than the bare disposer this returned before, because removal is no
 * longer the only thing an overlay has to say: positioning code that has just moved
 * the rectangle has to be able to say so, and a disposer with a property hung off it
 * would be a handle pretending to be a function.
 */
export interface OverlayRegistration {
  /**
   * Report that this overlay's rectangle has just been moved by code — the arm that
   * no observer can see, because positioning that writes `top` and `left` in one
   * synchronous pass changes neither the box's size nor its animation state.
   * Idempotent and safe after removal, where it does nothing.
   */
  moved(): void;
  /** Remove the overlay and disarm everything registering it armed. Idempotent. */
  remove(): void;
}

export interface PaneOcclusionRegistryOptions {
  /** The frame source motion sampling runs on. A real clock unless a test says otherwise. */
  readonly clock?: ConsoleClock | undefined;
}

interface RegisteredOverlay {
  readonly kind: OverlayKind;
  readonly read: OverlayRectReader;
  readonly element: Element | undefined;
  detachResizeObserver: Unsubscribe | undefined;
  queuedFrame: ScheduledHandle | undefined;
}

/**
 * Which overlays are on screen right now, as a set of rectangle READERS.
 *
 * Readers rather than rectangles because an overlay animates: a rectangle captured at
 * registration is where the overlay was before it opened, and the view would yield to
 * a box that has moved. A class rather than a module-level `Set` because an auxiliary
 * window is its own renderer process with its own overlays.
 */
export class PaneOcclusionRegistry implements PaneOverlaySource {
  readonly #overlaysByToken = new Map<number, RegisteredOverlay>();
  readonly #changeEmitter = new Emitter<void>("overlay geometry change");
  readonly #clock: ConsoleClock;
  #detachMotionStarts: Unsubscribe | undefined;
  #nextToken = 1;

  public constructor(options: PaneOcclusionRegistryOptions = {}) {
    this.#clock = options.clock ?? new RealClock();
  }

  /**
   * Register one live overlay. `remove` is the only removal, so an overlay that
   * unmounts without calling it keeps the view hidden — the fail-closed direction: a
   * stuck-hidden view is a visible bug, a view painted over a dialog is a hazard.
   *
   * `element` is what sources 2 and 3 observe. It is optional because an overlay
   * whose rectangle is computed rather than laid out has nothing to hand over, and
   * such an overlay is still correct through `moved()`.
   */
  public register(
    kind: OverlayKind,
    read: OverlayRectReader,
    element?: Element,
  ): OverlayRegistration {
    const token = this.#nextToken;
    this.#nextToken += 1;
    const overlay: RegisteredOverlay = {
      kind,
      read,
      element,
      detachResizeObserver: undefined,
      queuedFrame: undefined,
    };
    this.#overlaysByToken.set(token, overlay);
    if (element !== undefined) {
      overlay.detachResizeObserver = observeElementResize(element, () => {
        this.#changeEmitter.emit();
      });
      this.#armMotionStarts();
      if (hasRunningMotion(element)) {
        // Registered mid-animation — the case a start event has already been and gone
        // for, and the one a `transitionrun` listener alone would never sample.
        this.#sampleUntilStill(token);
      }
    }
    this.#changeEmitter.emit();
    return {
      moved: () => {
        this.#reportMoved(token);
      },
      remove: () => {
        this.#remove(token);
      },
    };
  }

  /** Fires whenever an overlay opens, closes, or moves, so a publisher re-samples. */
  public subscribeToChanges(sink: () => void): Unsubscribe {
    return this.#changeEmitter.subscribe(sink);
  }

  /** Every overlay rectangle on screen right now, in registration order. */
  public liveRects(): readonly PaneRect[] {
    const rects: PaneRect[] = [];
    for (const overlay of this.#overlaysByToken.values()) {
      const rect = overlay.read();
      if (rect !== undefined) {
        rects.push(rect);
      }
    }
    return rects;
  }

  /** How many overlays are registered. Read by the pane's own diagnostics. */
  public get registeredCount(): number {
    return this.#overlaysByToken.size;
  }

  /**
   * How many overlays have a frame armed. Zero is the idle-CPU budget's precondition
   * for this registry, and it is the assertion that "no frame loop at rest" is a
   * property rather than a promise.
   */
  public get samplingOverlayCount(): number {
    let sampling = 0;
    for (const overlay of this.#overlaysByToken.values()) {
      if (overlay.queuedFrame !== undefined) {
        sampling += 1;
      }
    }
    return sampling;
  }

  #reportMoved(token: number): void {
    if (this.#overlaysByToken.has(token)) {
      this.#changeEmitter.emit();
    }
  }

  #remove(token: number): void {
    const overlay = this.#overlaysByToken.get(token);
    if (overlay === undefined) {
      return;
    }
    overlay.detachResizeObserver?.();
    if (overlay.queuedFrame !== undefined) {
      this.#clock.cancel(overlay.queuedFrame);
      overlay.queuedFrame = undefined;
    }
    this.#overlaysByToken.delete(token);
    this.#disarmMotionStartsWhenNoElementRemains();
    this.#changeEmitter.emit();
  }

  #armMotionStarts(): void {
    if (this.#detachMotionStarts !== undefined) {
      return;
    }
    this.#detachMotionStarts = observeMotionStarts((movingNode) => {
      this.#onMotionStart(movingNode);
    });
  }

  #disarmMotionStartsWhenNoElementRemains(): void {
    if (this.#detachMotionStarts === undefined) {
      return;
    }
    for (const overlay of this.#overlaysByToken.values()) {
      if (overlay.element !== undefined) {
        return;
      }
    }
    this.#detachMotionStarts();
    this.#detachMotionStarts = undefined;
  }

  #onMotionStart(movingNode: Node): void {
    for (const [token, overlay] of this.#overlaysByToken) {
      if (overlay.element !== undefined && sharesMotionWith(overlay.element, movingNode)) {
        this.#sampleUntilStill(token);
      }
    }
  }

  #sampleUntilStill(token: number): void {
    const overlay = this.#overlaysByToken.get(token);
    if (overlay === undefined || overlay.queuedFrame !== undefined) {
      return;
    }
    overlay.queuedFrame = this.#clock.scheduleFrame(() => {
      this.#sampleFrame(token);
    });
  }

  #sampleFrame(token: number): void {
    const overlay = this.#overlaysByToken.get(token);
    if (overlay === undefined) {
      return;
    }
    overlay.queuedFrame = undefined;
    // Emit BEFORE re-reading the animation state, so the frame that finds the motion
    // finished still publishes the rectangle the overlay came to rest at.
    this.#changeEmitter.emit();
    if (overlay.element !== undefined && hasRunningMotion(overlay.element)) {
      this.#sampleUntilStill(token);
    }
  }
}

/** One per renderer process, like every other console registry. */
export const consoleOcclusionRegistry: PaneOcclusionRegistry = new PaneOcclusionRegistry();
