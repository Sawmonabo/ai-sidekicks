// How a pane drawing a native view watches the overlays it has to yield to move.
//
// `Spec-023 §Console Design (Meridian)` 12.3 puts the overlay set at the primitive
// layer and the yield rule here. The set is `core/`'s airspace registry, which every
// overlay primitive registers into; this module is the half of the observation that
// only a native-view consumer needs, and it is installed by that consumer rather than
// standing on its own.
//
// AN OVERLAY MOVES AFTER IT REGISTERS. Opening and closing are not the only moments a
// rectangle changes: a popover is positioned AFTER it mounts, a dialog animates in, a
// toast grows as its text wraps, a rail collapse carries everything inside it. Two of
// those change the box and the registrant's own size seam reports them. The third does
// not: an element carried across the screen by a transition changes neither its size
// nor anything an observer can see, and a transition reports its START and its END and
// says nothing in between. So a moving overlay is sampled once per animation frame
// while it is in flight, and the loop stops on the first frame that finds nothing
// running — that last frame is the one that publishes where the overlay came to rest.
//
// NOTHING SAMPLES AT REST, and nothing samples at all while no pane is drawing a view.
// The console's budgets forbid idle CPU, so the loop is armed by a motion START and by
// an observation that begins mid-animation, and it disarms itself. The old arrangement
// ran this for every overlay in the window whether or not anything was yielding to one;
// installing it from the consumer is what makes "no view, no frame loop" structural.

import type {
  AirspaceMotionObserver,
  AirspaceOverlayElement,
  ConsoleClock,
  Unsubscribe,
} from "../../core/index.js";
import { hasRunningMotion, observeMotionStarts, sharesMotionWith } from "./element-motion.js";
import { MotionFrameSampler } from "./motion-sampling.js";

/**
 * One window's overlay-motion observation, shared by every element it is asked to
 * watch.
 *
 * A class rather than a closure per element because the motion-START seam is a
 * document-level listener: one per observation, armed while at least one element is
 * watched and disarmed when the last one goes. A listener per overlay would be one
 * document subscription per open dialog for a signal every one of them reads.
 */
class OverlayMotionObservation {
  readonly #clock: ConsoleClock;
  readonly #samplersByElement = new Map<Element, MotionFrameSampler>();
  #detachMotionStarts: Unsubscribe | undefined;

  public constructor(clock: ConsoleClock) {
    this.#clock = clock;
  }

  /** Watch one overlay element until the returned disarm is called. */
  public observe(element: Element, onMoved: () => void): Unsubscribe {
    const sampler = new MotionFrameSampler({
      // An overlay yields to the motion that CARRIES it, which is the same width the
      // start filter below uses. `hasRunningMotion` runs the box-moving filter, so an
      // overlay holding a `not-loaded` skeleton — an infinite opacity pulse for as
      // long as a read is out — arms no frame at all. Unfiltered, one loading dialog
      // kept a sampler running for the life of the read and reported nothing anybody
      // could see, which is the permanent frame loop the idle-CPU budget forbids.
      isMotionRunning: () => hasRunningMotion(element),
      clock: this.#clock,
      onFrame: onMoved,
    });
    this.#samplersByElement.set(element, sampler);
    this.#armMotionStarts();
    if (hasRunningMotion(element)) {
      // Observed mid-animation — the case a start event has already been and gone for,
      // and the one a start listener alone would never sample.
      sampler.startIfIdle();
    }
    return () => {
      sampler.stop();
      this.#samplersByElement.delete(element);
      this.#disarmMotionStartsWhenEmpty();
    };
  }

  /** How many elements have a frame armed. Zero at rest, and that is the budget. */
  public get samplingElementCount(): number {
    let sampling = 0;
    for (const sampler of this.#samplersByElement.values()) {
      if (sampler.isSampling) {
        sampling += 1;
      }
    }
    return sampling;
  }

  #armMotionStarts(): void {
    if (this.#detachMotionStarts !== undefined) {
      return;
    }
    this.#detachMotionStarts = observeMotionStarts((movingNode) => {
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
 * Whether the airspace handed over something this window can watch move.
 *
 * The airspace holds an overlay's element opaquely, because `core/` compiles with no
 * DOM lib and reads no property of it. This module reads two — the running animations
 * that say the box is in flight, and the containment that says which motion carries it
 * — so the narrowing happens here, at the one boundary that needs the platform type,
 * and an overlay that is not a DOM element is watched by nothing rather than crashing
 * a sampler on a value it cannot read.
 */
function isWatchableElement(subject: AirspaceOverlayElement): subject is Element {
  return "getAnimations" in subject && "contains" in subject;
}

/**
 * The observer a native-view consumer installs into its window's airspace.
 *
 * Takes the clock rather than minting one, for the reason the geometry binding gives
 * about its own: a `RealClock` minted privately is invisible to `ManualClock`, which
 * is the instrument the console counts timers with, so a sampler that minted one ran
 * on wall time inside a window whose every other timer was frozen.
 */
export function overlayMotionObserver(clock: ConsoleClock): AirspaceMotionObserver {
  const observation = new OverlayMotionObservation(clock);
  return (element, onMoved) =>
    isWatchableElement(element) ? observation.observe(element, onMoved) : () => undefined;
}
