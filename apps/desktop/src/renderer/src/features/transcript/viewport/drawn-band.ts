// How far beyond the viewport the list draws, in screen heights. A land draws only the rows on
// screen in its own task; once it has landed the band widens a step per task until it is whole,
// and at once when the reader acts or scrolls, so a reader who scrolls never meets rows the band
// has not reached. The whole band reaches further on the side the reader last moved toward, so
// a fast frame of a fling lands on rows already drawn. A step that finds a land still on its way
// waits for the frame to say it landed. The band starts narrow, because a session opens by
// landing on its tail.

import { type Clock, type ScheduledHandle } from "#renderer/lib/clock.js";
import { type ScrollGeometry } from "#renderer/lib/scroll/geometry/sample.js";
import {
  TRANSCRIPT_BAND_WIDENING_SCREEN_HEIGHTS,
  TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
  TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS,
} from "./caps.js";
import { type WindowSide } from "./window-cap.js";

/** The band beyond each edge of the viewport, in screen heights. */
export type DrawnBandScreenHeights = Readonly<Record<WindowSide, number>>;

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
  /** Each side's band, narrowed by a land; the leading side reaches further once it is whole. */
  #sideScreenHeights = 0;
  /** The side the reader last moved toward, or `undefined` before they have moved. */
  #leadingSide: WindowSide | undefined;
  #screenHeights: DrawnBandScreenHeights = { head: 0, tail: 0 };
  /** The offset of the last sample, so a scroll event's sample tells which way the reader moved. */
  #lastScrollTopPx: number | undefined;
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

  /** The band beyond each edge of the viewport now; a new object only when a side changed. */
  public get screenHeights(): DrawnBandScreenHeights {
    return this.#screenHeights;
  }

  /**
   * A land is starting: draw only the rows on screen, and widen over the tasks after it lands.
   * The caller's pass publishes the narrowed band with the rows it lands on.
   */
  public narrow(): void {
    this.#isWaitingForLand = false;
    this.#scheduleStep();
    if (this.#sideScreenHeights !== 0) {
      this.#sideScreenHeights = 0;
      this.#update();
      this.#redraw();
    }
  }

  /**
   * The reader acted, toward `towardSide` when the input says which way: the whole band now, so
   * nothing they scroll to is undrawn, reaching further on the side they move toward.
   */
  public widenFully(towardSide?: WindowSide): void {
    this.#leadingSide = towardSide ?? this.#leadingSide;
    const wasWhole = this.#sideScreenHeights === TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS;
    if (!wasWhole) {
      this.#cancelStep();
      this.#isWaitingForLand = false;
      this.#sideScreenHeights = TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS;
    }
    if (this.#update() || !wasWhole) {
      this.#redraw();
      this.#publish();
    }
  }

  /**
   * A geometry sample: one a scroll event published is the reader's own scroll, a fling's after
   * the hand let go among them, which sends no input, so it widens the band as input does. The
   * transcript's own writes publish theirs without an event, and only move the offset compared.
   */
  public observeGeometry(geometry: ScrollGeometry): void {
    const lastScrollTopPx = this.#lastScrollTopPx;
    this.#lastScrollTopPx = geometry.scrollTop;
    if (geometry.inputAt === undefined || lastScrollTopPx === undefined) {
      return;
    }
    this.widenFully(
      geometry.scrollTop < lastScrollTopPx
        ? "head"
        : geometry.scrollTop > lastScrollTopPx
          ? "tail"
          : undefined,
    );
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

  /** Brings `screenHeights` to the sides' widths, answering whether either side changed. */
  #update(): boolean {
    const sideScreenHeights = this.#sideScreenHeights;
    const leadingScreenHeights =
      sideScreenHeights === TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS
        ? TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS
        : sideScreenHeights;
    const next: DrawnBandScreenHeights = {
      head: this.#leadingSide === "head" ? leadingScreenHeights : sideScreenHeights,
      tail: this.#leadingSide === "tail" ? leadingScreenHeights : sideScreenHeights,
    };
    if (next.head === this.#screenHeights.head && next.tail === this.#screenHeights.tail) {
      return false;
    }
    this.#screenHeights = next;
    return true;
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
    this.#sideScreenHeights = Math.min(
      TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
      this.#sideScreenHeights + TRANSCRIPT_BAND_WIDENING_SCREEN_HEIGHTS,
    );
    this.#update();
    this.#redraw();
    this.#publish();
    if (this.#sideScreenHeights < TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS) {
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
