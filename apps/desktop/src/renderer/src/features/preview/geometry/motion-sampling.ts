// The frame loop one moving element is sampled on. A transition reports only its start and end,
// so an element carried across the screen is read once a frame while in flight. The loop takes
// a predicate and a clock and touches no document, so the overlay observation and the pane's
// position observer bound motion differently and still share it.

import type { Clock, ScheduledHandle } from "@renderer/lib/clock.js";

/** What a `MotionFrameSampler` needs: the motion predicate, the frame source and the report. */
export interface MotionFrameSamplerOptions {
  /**
   * Whether motion that could still move this caller's subject is running. A predicate rather
   * than an element, because the two callers bound motion differently.
   */
  readonly isMotionRunning: () => boolean;
  /** The frame source. A real clock unless a test says otherwise. */
  readonly clock: Clock;
  /** Called once per frame while the subject is moving, and once as it comes to rest. */
  readonly onFrame: () => void;
}

/**
 * Per-frame sampling of one moving element, armed by motion and disarmed by stillness. The
 * frame that finds nothing running is the last, and it still reports: that report is where the
 * element came to rest.
 */
export class MotionFrameSampler {
  readonly #isMotionRunning: () => boolean;
  readonly #clock: Clock;
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
    // Report before re-reading, so the frame that finds the motion finished still reports where
    // the element came to rest.
    this.#onFrame();
    if (this.#isMotionRunning()) {
      this.startIfIdle();
    }
  }
}
