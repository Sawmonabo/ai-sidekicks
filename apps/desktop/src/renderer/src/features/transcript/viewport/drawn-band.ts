// How far beyond the viewport the list draws, in screen heights. A land draws only the rows on
// screen in its own task; once it has landed the band widens a step per task until it is whole,
// and at once when the reader acts, so a reader who scrolls never meets rows the band has not
// reached. A step that finds a land still on its way waits for the frame to say it landed. The
// band starts narrow, because a session opens by landing on its tail.

import { type Clock, type ScheduledHandle } from "#renderer/lib/clock.js";
import {
  TRANSCRIPT_BAND_WIDENING_SCREEN_HEIGHTS,
  TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
} from "./caps.js";

/** Dependencies of a `ViewportDrawnBand`. */
export interface ViewportDrawnBandOptions {
  readonly clock: Clock;
  /** Whether a land is on its way, so its rows are drawn at the offset it ends at. */
  readonly isLanding: () => boolean;
  /** The band's width changed: the list's next render draws the band as it now stands. */
  readonly redraw: () => void;
  /** Tell the list to render, for a widening no pass of the frame's own publishes. */
  readonly publish: () => void;
}

/** The drawn band's width, narrowed by each land and widened over the tasks after it. */
export class ViewportDrawnBand {
  readonly #clock: Clock;
  readonly #isLanding: () => boolean;
  readonly #redraw: () => void;
  readonly #publish: () => void;
  #screenHeights = 0;
  #widening: ScheduledHandle | undefined;
  /** Whether a step found a land on its way and waits for `review` to find it landed. */
  #isWaitingForLand = false;

  public constructor(options: ViewportDrawnBandOptions) {
    this.#clock = options.clock;
    this.#isLanding = options.isLanding;
    this.#redraw = options.redraw;
    this.#publish = options.publish;
    this.#scheduleStep();
  }

  /** The band beyond each edge of the viewport now, in screen heights. */
  public get screenHeights(): number {
    return this.#screenHeights;
  }

  /**
   * A land is starting: draw only the rows on screen, and widen over the tasks after it lands.
   * The caller's pass publishes the narrowed band with the rows it lands on.
   */
  public narrow(): void {
    this.#isWaitingForLand = false;
    this.#scheduleStep();
    if (this.#screenHeights !== 0) {
      this.#screenHeights = 0;
      this.#redraw();
    }
  }

  /** The reader acted: the whole band now, so nothing they scroll to is undrawn. */
  public widenFully(): void {
    if (this.#screenHeights === TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS) {
      return;
    }
    this.#cancelStep();
    this.#isWaitingForLand = false;
    this.#screenHeights = TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS;
    this.#redraw();
    this.#publish();
  }

  /** The frame moved or committed: a step waiting for a land goes on once it has landed. */
  public review(): void {
    if (this.#isWaitingForLand && !this.#isLanding()) {
      this.#isWaitingForLand = false;
      this.#scheduleStep();
    }
  }

  /** Terminal: no step runs after it. */
  public dispose(): void {
    this.#cancelStep();
  }

  #scheduleStep(): void {
    this.#cancelStep();
    this.#widening = this.#clock.scheduleTimeout(() => {
      this.#widening = undefined;
      this.#step();
    }, 0);
  }

  /** One step wider, or, with a land still on its way, a wait for `review`. */
  #step(): void {
    if (this.#isLanding()) {
      this.#isWaitingForLand = true;
      return;
    }
    this.#screenHeights = Math.min(
      TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
      this.#screenHeights + TRANSCRIPT_BAND_WIDENING_SCREEN_HEIGHTS,
    );
    this.#redraw();
    this.#publish();
    if (this.#screenHeights < TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS) {
      this.#scheduleStep();
    }
  }

  #cancelStep(): void {
    if (this.#widening !== undefined) {
      this.#clock.cancel(this.#widening);
      this.#widening = undefined;
    }
  }
}
