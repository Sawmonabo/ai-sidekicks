// How a pane drawing a native view watches the overlays it yields to move. The overlay set is
// the airspace registry in `lib/`; this consumer installs the observation, so while no pane draws
// a view no frame is armed. A transition reports only its start and end, so a moving overlay is
// sampled once per frame in flight, and the last frame publishes where it came to rest.

import type { AirspaceMotionObserver, AirspaceOverlayElement } from "#renderer/lib/airspace.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { hasRunningMotion, observeMotionStarts, sharesMotionWith } from "./element-motion.js";
import { MotionFrameSampler } from "./motion-sampling.js";

/**
 * The observer a native-view consumer installs into its window's airspace. Takes the clock
 * rather than minting one, so the sampler runs on the window's clock (frozen in tests) instead
 * of wall time.
 */
export function overlayMotionObserver(clock: Clock): AirspaceMotionObserver {
  const observation = new OverlayMotionObservation(clock);
  return (element, onMoved) =>
    isWatchableElement(element) ? observation.observe(element, onMoved) : () => undefined;
}

/**
 * One window's overlay-motion observation, shared by every element it watches. A class because
 * the motion-start seam is one document-level listener, armed while any element is watched and
 * disarmed when the last goes, not one per open dialog.
 */
class OverlayMotionObservation {
  readonly #clock: Clock;
  readonly #samplersByElement = new Map<Element, MotionFrameSampler>();
  #detachMotionStarts: Unsubscribe | undefined;

  public constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Watch one overlay element until the returned disarm is called. */
  public observe(element: Element, onMoved: () => void): Unsubscribe {
    const sampler = new MotionFrameSampler({
      // An overlay yields to the motion that carries it, the width the start filter below uses.
      // The box-moving filter keeps a loading skeleton's opacity pulse from arming a frame loop.
      isMotionRunning: () => hasRunningMotion(element),
      clock: this.#clock,
      onFrame: onMoved,
    });
    this.#samplersByElement.set(element, sampler);
    this.#armMotionStarts(element.ownerDocument);
    if (hasRunningMotion(element)) {
      // Observed mid-animation: the start event has already come and gone.
      sampler.startIfIdle();
    }
    return () => {
      sampler.stop();
      this.#samplersByElement.delete(element);
      this.#disarmMotionStartsWhenEmpty();
    };
  }

  /** Every watched overlay is in one document: the airspace it came from is that document's. */
  #armMotionStarts(ownerDocument: Document): void {
    if (this.#detachMotionStarts !== undefined) {
      return;
    }
    this.#detachMotionStarts = observeMotionStarts(ownerDocument, (movingNode) => {
      for (const [element, sampler] of this.#samplersByElement) {
        if (sharesMotionWith(element, movingNode)) {
          sampler.startIfIdle();
        }
      }
    });
  }

  #disarmMotionStartsWhenEmpty(): void {
    if (this.#detachMotionStarts === undefined || this.#samplersByElement.size > 0) {
      return;
    }
    this.#detachMotionStarts();
    this.#detachMotionStarts = undefined;
  }
}

/**
 * Whether the airspace handed over something this window can watch move. The airspace holds
 * overlay elements opaquely (it compiles with no DOM lib), so the narrowing to the platform type
 * happens here, and a non-element overlay is watched by nothing rather than crashing a sampler.
 */
function isWatchableElement(subject: AirspaceOverlayElement): subject is Element {
  return "getAnimations" in subject && "contains" in subject;
}
