// The overlays a native view yields to. Every overlay primitive registers a rectangle reader on
// mount, and a view yields while any registered rectangle intersects its pane. It lives in `lib/`
// because the registrants are the shared overlay components (through
// `hooks/useAirspaceRegistration.ts`) and the readers are the preview geometry and the session
// pane layout.
//
// It observes nothing by itself: the consumer that draws a native view installs the motion
// sampler through {@link AirspaceRegistry.installMotionObserver}, so no frame is armed while
// nothing watches. It names no DOM type because `lib/` is also compiled by programs with no DOM
// lib; the element and the window are opaque here.

import { Emitter, type Unsubscribe } from "./emitter.js";

/** The element an overlay hands over for an installed observer to watch; never read here. */
export type AirspaceOverlayElement = object;

/** A rectangle in CSS pixels, viewport-relative. */
export interface AirspaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One overlay's live rectangle, read at the moment the predicate asks. */
export type AirspaceRectReader = () => AirspaceRect | undefined;

/**
 * What a registered overlay holds.
 *
 * Not a bare disposer because code that sets `top` and `left` in one pass changes neither size
 * nor animation state, so no observer sees the move and the overlay must report it.
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
 * Installed rather than owned, so no frame loop runs for overlays nothing is yielding to.
 */
export type AirspaceMotionObserver = (
  element: AirspaceOverlayElement,
  onMoved: () => void,
) => Unsubscribe;

/**
 * Which overlays are on screen right now, as a set of rectangle readers.
 *
 * Readers rather than rectangles because an overlay animates: a rectangle captured at
 * registration is where the overlay was before it opened.
 */
export class AirspaceRegistry {
  readonly #overlaysByToken = new Map<number, RegisteredOverlay>();
  readonly #installedObservers = new Set<AirspaceMotionObserver>();
  readonly #changeEmitter = new Emitter<void>("airspace geometry change");
  #nextToken = 1;

  /**
   * Register one live overlay. `remove` is the only removal, so an overlay that unmounts without
   * it keeps the view hidden: a stuck-hidden view is a visible bug, a view over a dialog a hazard.
   *
   * `element` is what an installed observer watches; an overlay with a computed rectangle has
   * none and reports movement through `moved()`.
   */
  public register(
    read: AirspaceRectReader,
    element?: AirspaceOverlayElement,
  ): AirspaceRegistration {
    const token = this.#nextToken;
    this.#nextToken += 1;
    const overlay: RegisteredOverlay = {
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
   * Watch every registered overlay element for movement until the returned function is called.
   * Arms overlays already registered and every later one, so install order does not matter.
   */
  public installMotionObserver(observe: AirspaceMotionObserver): Unsubscribe {
    if (this.#installedObservers.has(observe)) {
      // A second install of the same observer would overwrite its disarms.
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

  /** How many overlays are registered. */
  public get registeredCount(): number {
    return this.#overlaysByToken.size;
  }

  /** How many overlay armings are live across all installed observers; zero when none is. */
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

interface RegisteredOverlay {
  readonly read: AirspaceRectReader;
  readonly element: AirspaceOverlayElement | undefined;
  /** One disarm per installed observer, so an uninstall disarms only its own. */
  readonly disarmByObserver: Map<AirspaceMotionObserver, Unsubscribe>;
}
