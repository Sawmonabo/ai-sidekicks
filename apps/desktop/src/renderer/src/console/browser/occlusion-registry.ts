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
//      where the overlay came to rest. The loop itself is `motion-sampling.ts`'s,
//      because the pane's own position observer needs the same one — this registry
//      owns WHICH overlays it runs for and not how it runs.
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

import { Emitter, type ConsoleClock, type Unsubscribe } from "../core/index.js";
import { consoleClockFor, type ConsoleBridge } from "../bridge/index.js";
import { observeElementResize } from "../primitives/index.js";
import { hasRunningMotion, observeMotionStarts, sharesMotionWith } from "./element-motion.js";
import { MotionFrameSampler } from "./motion-sampling.js";
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
  /**
   * The frame source motion sampling runs on. REQUIRED, and required rather than
   * defaulted for the reason a default is usually chosen: a `RealClock` minted here
   * is invisible to `ManualClock`, which is the instrument the console counts timers
   * with, so a registry that quietly minted one sampled on wall time inside a window
   * whose every other timer was frozen. There is no clock this module can pick that
   * is right for both windows; the window's owner knows, and now has to say.
   */
  readonly clock: ConsoleClock;
}

interface RegisteredOverlay {
  readonly kind: OverlayKind;
  readonly read: OverlayRectReader;
  readonly element: Element | undefined;
  detachResizeObserver: Unsubscribe | undefined;
  /** Source 3's loop, present only for an overlay that registered an element. */
  readonly motionSampler: MotionFrameSampler | undefined;
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

  public constructor(options: PaneOcclusionRegistryOptions) {
    this.#clock = options.clock;
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
      motionSampler:
        element === undefined
          ? undefined
          : new MotionFrameSampler({
              // An overlay yields to the motion that CARRIES it, which is the same
              // width its start-event filter uses below. The pane's own position
              // observer reads the document instead, because a sibling can move a
              // pane without carrying it — an overlay's rectangle is read live on
              // every change, so it needs no such measurement.
              //
              // WHAT THAT READING EXCLUDES, and why this path needs it as much as
              // the document one does. `hasRunningMotion` runs
              // `animation-motion.ts`'s box-moving filter, so an overlay holding a
              // `not-loaded` skeleton — an infinite opacity pulse on every read in
              // flight — arms no frame at all. Unfiltered, one loading dialog kept
              // this sampler running for as long as the read was out and emitted an
              // occlusion change on every animation frame, which is the permanent
              // RAF loop the idle-CPU budget forbids and which nothing on screen
              // reported.
              isMotionRunning: () => hasRunningMotion(element),
              clock: this.#clock,
              onFrame: () => {
                this.#changeEmitter.emit();
              },
            }),
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
        overlay.motionSampler?.startIfIdle();
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
      if (overlay.motionSampler?.isSampling === true) {
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
    overlay.motionSampler?.stop();
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
    for (const overlay of this.#overlaysByToken.values()) {
      if (overlay.element !== undefined && sharesMotionWith(overlay.element, movingNode)) {
        overlay.motionSampler?.startIfIdle();
      }
    }
  }
}

/**
 * The registries this process holds, one per window, held weakly by that window.
 *
 * A `WeakMap` rather than a module-level instance because the instance could not be
 * constructed at all any more, and that is the correction rather than a consequence
 * of it: a registry minted at module load has no window to take a clock from, so it
 * took a `RealClock` — and under the fixture that put overlay motion sampling on wall
 * time inside a window whose scenario beats, refresh scheduler, and stores all ran on
 * the frozen one. Keyed on the BRIDGE and not on the clock, because
 * `consoleClockFor` mints a fresh `RealClock` per caller on the live arm, so a
 * clock-keyed table would hand every pane in one window a registry of its own and the
 * view would yield to whichever overlays happened to register through the same one.
 */
const occlusionRegistriesByWindow = new WeakMap<ConsoleBridge, PaneOcclusionRegistry>();

/**
 * The one registry this window's overlays share, minted against this window's clock.
 *
 * ONE PER WINDOW, which is what "one per renderer process" meant when the console had
 * a single bridge: an auxiliary window is its own renderer process with its own
 * overlays, and a second bridge in one process — which every suite that builds two
 * fixture bridges has — is two windows for every purpose this registry serves.
 */
export function consoleOcclusionRegistryFor(bridge: ConsoleBridge): PaneOcclusionRegistry {
  const held = occlusionRegistriesByWindow.get(bridge);
  if (held !== undefined) {
    return held;
  }
  const created = new PaneOcclusionRegistry({ clock: consoleClockFor(bridge) });
  occlusionRegistriesByWindow.set(bridge, created);
  return created;
}
