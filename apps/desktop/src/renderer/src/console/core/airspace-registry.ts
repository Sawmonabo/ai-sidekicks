// The overlay set a native view yields to — the console's one airspace.
//
// `Spec-023 §Console Design (Meridian)` 12.3: "Every overlay primitive registers its
// own rectangle on mount … The visibility predicate consults the registry, and an
// overlay whose rectangle intersects the pane makes the view yield. Registration
// happens once, at the primitive layer, never per overlay instance." §4.3 states the
// same rule from the deck's side and calls it the airspace registry. The wire table
// for both reads `renderer-local`, and this module is that locality.
//
// WHY IT IS AT THE DAG FLOOR. It was minted in `browser/geometry/`, beside the one
// surface that reads it, and its own header recorded the consequence: `primitives/`
// sits BELOW a view family, so no overlay primitive could import it and the registry
// shipped with zero registrants — a set the visibility predicate consulted and that
// nothing ever put anything into. The registrants are the primitive layer and the
// reader is a view family, and `core/` is the only rung both of them can reach. The
// workspace family's deck carries a second registry of the same name for the same
// rule; the merge that lands it retires that one in favour of this, for the reason
// this paragraph gives — one airspace per window, not one per family that draws into
// it.
//
// WHAT IT HOLDS AND WHAT IT DOES NOT. It holds registrations, their rectangle
// READERS, and the change stream a publisher re-samples on. It observes nothing by
// itself: `core/` may not import the size-observer chokepoint in `primitives/` and
// may not reach the motion sampler in the browser family, and neither restriction is
// a loss, because the only consumer that needs sub-frame accuracy is the one drawing
// a native view. So OBSERVATION IS INSTALLED BY THAT CONSUMER through
// {@link AirspaceRegistry.installMotionObserver}, and while no such consumer exists
// no frame is ever armed — which is a stronger reading of the idle-CPU budget than
// the standing arrangement it replaces, where every overlay sampled whether or not
// anything was watching.
//
// AND IT NAMES NO DOM TYPE, on `clock.ts`'s precedent and for its reason: `core/` is
// compiled by a Node-context program with no DOM lib (the assets tier imports this
// family's door), so `Element` does not resolve here and `Document` resolves to
// something that is not a document. The two things this module holds on an overlay's
// behalf — the element an installed observer watches, and the window an airspace
// belongs to — are opaque here because this module never reads either one. The types
// below say exactly that, and the consumer that DOES read an element narrows to the
// platform type at its own boundary.

import { Emitter, type Unsubscribe } from "./emitter.js";

/**
 * The element an overlay hands over for an installed observer to watch.
 *
 * Opaque, because the registry holds it and passes it on and reads no property of it.
 * A caller passes a DOM element; the type is the widest one that is honest about what
 * happens to it here.
 */
export type AirspaceOverlayElement = object;

/** A rectangle in CSS pixels, viewport-relative. The one rect shape both sides read. */
export interface AirspaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One overlay's live rectangle, read at the moment the predicate asks. */
export type AirspaceRectReader = () => AirspaceRect | undefined;

/**
 * The overlay kinds 12.3 enumerates. Closed, and the enumeration is the claim: a new
 * overlay primitive joins this tuple in the edit that makes it register.
 */
export const AIRSPACE_OVERLAY_KINDS = [
  "dialog",
  "popover",
  "context-menu",
  "toast",
  "command-palette",
  "image-lightbox",
  "diagram-lightbox",
] as const;

export type AirspaceOverlayKind = (typeof AIRSPACE_OVERLAY_KINDS)[number];

/**
 * What a registered overlay holds.
 *
 * An object rather than a bare disposer, because removal is not the only thing an
 * overlay has to say: positioning code that has just written `top` and `left` in one
 * synchronous pass changes neither the box's size nor its animation state, so no
 * observer can see it and the overlay has to report the move itself.
 */
export interface AirspaceRegistration {
  /** Report a rectangle this overlay just moved by code. Idempotent, safe after removal. */
  moved(): void;
  /** Remove the overlay and disarm every observation it armed. Idempotent. */
  remove(): void;
}

/**
 * How a consumer that draws a native view watches one overlay element for movement.
 *
 * Installed rather than owned, for the reason the header gives: the machinery lives
 * two families above this one, and a registry that armed it unconditionally would run
 * a frame loop for overlays nothing is yielding to.
 */
export type AirspaceMotionObserver = (
  element: AirspaceOverlayElement,
  onMoved: () => void,
) => Unsubscribe;

interface RegisteredOverlay {
  readonly kind: AirspaceOverlayKind;
  readonly read: AirspaceRectReader;
  readonly element: AirspaceOverlayElement | undefined;
  /** One disarm per installed observer, so an uninstall disarms only its own. */
  readonly disarmByObserver: Map<AirspaceMotionObserver, Unsubscribe>;
}

/**
 * Which overlays are on screen right now, as a set of rectangle READERS.
 *
 * Readers rather than rectangles because an overlay animates: a rectangle captured at
 * registration is where the overlay was before it opened, and the view would yield to
 * a box that has moved. A class rather than a module-level `Set` because an auxiliary
 * window is its own renderer process with its own overlays.
 */
export class AirspaceRegistry {
  readonly #overlaysByToken = new Map<number, RegisteredOverlay>();
  readonly #installedObservers = new Set<AirspaceMotionObserver>();
  readonly #changeEmitter = new Emitter<void>("airspace geometry change");
  #nextToken = 1;

  /**
   * Register one live overlay. `remove` is the only removal, so an overlay that
   * unmounts without calling it keeps the view hidden — the fail-closed direction: a
   * stuck-hidden view is a visible bug, a view painted over a dialog is a hazard.
   *
   * `element` is what an installed observer watches. It is optional because an overlay
   * whose rectangle is computed rather than laid out has nothing to hand over, and
   * such an overlay is still correct through `moved()`.
   */
  public register(
    kind: AirspaceOverlayKind,
    read: AirspaceRectReader,
    element?: AirspaceOverlayElement,
  ): AirspaceRegistration {
    const token = this.#nextToken;
    this.#nextToken += 1;
    const overlay: RegisteredOverlay = {
      kind,
      read,
      element,
      disarmByObserver: new Map<AirspaceMotionObserver, Unsubscribe>(),
    };
    this.#overlaysByToken.set(token, overlay);
    if (element !== undefined) {
      for (const observe of this.#installedObservers) {
        this.#armOverlay(overlay, observe);
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

  /**
   * Watch every registered overlay element for movement, until the answer is called.
   *
   * Arms the overlays already registered and every one that registers later, which is
   * what makes install order irrelevant: a pane that opens after a dialog watches that
   * dialog, and a dialog that opens after a pane is watched by it.
   */
  public installMotionObserver(observe: AirspaceMotionObserver): Unsubscribe {
    if (this.#installedObservers.has(observe)) {
      // One identity, one installation. A second install of the same observer would
      // overwrite its own disarms and leave the first arming un-disarmable.
      return () => {
        this.#uninstallMotionObserver(observe);
      };
    }
    this.#installedObservers.add(observe);
    for (const overlay of this.#overlaysByToken.values()) {
      this.#armOverlay(overlay, observe);
    }
    return () => {
      this.#uninstallMotionObserver(observe);
    };
  }

  /** Fires whenever an overlay opens, closes, or moves, so a publisher re-samples. */
  public subscribeToChanges(sink: () => void): Unsubscribe {
    return this.#changeEmitter.subscribe(sink);
  }

  /** Every overlay rectangle on screen right now, in registration order. */
  public liveRects(): readonly AirspaceRect[] {
    const rects: AirspaceRect[] = [];
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
   * How many overlay armings are live across every installed observer.
   *
   * Zero with nothing installed is the idle-CPU budget's precondition for this
   * registry, and it is how "no observation while nothing is watching" is checked
   * rather than promised.
   */
  public get observedOverlayCount(): number {
    let observed = 0;
    for (const overlay of this.#overlaysByToken.values()) {
      observed += overlay.disarmByObserver.size;
    }
    return observed;
  }

  #armOverlay(overlay: RegisteredOverlay, observe: AirspaceMotionObserver): void {
    const element = overlay.element;
    if (element === undefined || overlay.disarmByObserver.has(observe)) {
      return;
    }
    overlay.disarmByObserver.set(
      observe,
      observe(element, () => {
        this.#changeEmitter.emit();
      }),
    );
  }

  #uninstallMotionObserver(observe: AirspaceMotionObserver): void {
    if (!this.#installedObservers.delete(observe)) {
      return;
    }
    for (const overlay of this.#overlaysByToken.values()) {
      overlay.disarmByObserver.get(observe)?.();
      overlay.disarmByObserver.delete(observe);
    }
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
    for (const disarm of overlay.disarmByObserver.values()) {
      disarm();
    }
    overlay.disarmByObserver.clear();
    this.#overlaysByToken.delete(token);
    this.#changeEmitter.emit();
  }
}
