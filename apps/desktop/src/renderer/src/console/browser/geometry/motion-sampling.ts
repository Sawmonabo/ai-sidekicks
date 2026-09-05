// The frame loop one moving element is sampled on.
//
// `element-motion.ts` holds the DOM SEAMS — which events announce motion, which
// animations could be carrying an element, which ancestors can move it. This module
// holds the LOOP those seams feed: a transition reports its start and its end and
// says nothing in between, so an element being carried across the screen is only
// readable by looking once a frame while it is in flight.
//
// Split from the seams because it depends on none of them. The loop takes a
// predicate and a clock and touches no document at all, which is what lets both
// callers — the overlay registry and the pane's position observer — bound motion
// differently while sharing one loop.

import type { ConsoleClock, ScheduledHandle } from "../../core/index.js";

export interface MotionFrameSamplerOptions {
  /**
   * Whether motion that could still be moving this caller's subject is running.
   *
   * The PREDICATE rather than the element, because the two callers bound motion
   * differently and the loop is the same either way: an overlay yields to what
   * carries it, and a pane has to watch a document that can move it from anywhere.
   * Handing the loop an element would put that judgment here, where neither caller
   * could state it.
   */
  readonly isMotionRunning: () => boolean;
  /** The frame source. A real clock unless a test says otherwise. */
  readonly clock: ConsoleClock;
  /** Called once per frame while the subject is moving, and once as it comes to rest. */
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
  readonly #isMotionRunning: () => boolean;
  readonly #clock: ConsoleClock;
  readonly #onFrame: () => void;
  #queuedFrame: ScheduledHandle | undefined;

  public constructor(options: MotionFrameSamplerOptions) {
    this.#isMotionRunning = options.isMotionRunning;
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
    if (this.#isMotionRunning()) {
      this.startIfIdle();
    }
  }
}
