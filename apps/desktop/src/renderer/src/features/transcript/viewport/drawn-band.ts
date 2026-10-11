// How far beyond the viewport the list draws, in screen heights. A land draws only the rows on
// screen in its own task; once it has landed the band widens a step per task until it is whole,
// and at once when the reader acts or scrolls, so a reader who scrolls never meets rows the band
// has not reached. The whole band reaches further on the side the reader last moved toward, so
// a fast frame of a fling lands on rows already drawn. A step that finds a land still on its way
// waits for the frame to say it landed. The band starts narrow, because a session opens by
// landing on its tail. A window nested in a row draws its own items within the same band, except
// before the reader has moved one way: a fling's first frame can carry the box further than the
// band before the next render draws, so each side the box can still move toward reaches as far as
// the leading side does. A fling's leading side reaches as far as its speed carries the box over a
// late frame, a step at a time, and back once it slows or a press stops it.

import { type Clock, type ScheduledHandle } from "#renderer/lib/clock.js";
import {
  SCROLL_GEOMETRY_EPSILON_PX,
  type ScrollGeometry,
} from "#renderer/lib/scroll/geometry/sample.js";
import {
  TRANSCRIPT_BAND_WIDENING_SCREEN_HEIGHTS,
  TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
  TRANSCRIPT_FLING_BAND_MAX_SCREEN_HEIGHTS,
  TRANSCRIPT_FLING_BAND_STEP_SCREEN_HEIGHTS,
  TRANSCRIPT_GESTURE_GAP_MS,
  TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS,
} from "./caps.js";
import { type WindowSide } from "./window-side.js";

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
  #nestedScreenHeights: DrawnBandScreenHeights = { head: 0, tail: 0 };
  /** The ends the box stood at in the last sample: a resting band leads only away from them. */
  #isAtHead = false;
  #isAtTail = false;
  /** The offset of the last sample, so a scroll event's sample tells which way the reader moved. */
  #lastScrollTopPx: number | undefined;
  /** The scroll event time stamp of the last sample one published, so its speed is told. */
  #lastInputAt: number | undefined;
  /** How far the leading side reaches for the fling under way, in screen heights; `0` at rest. */
  #flingScreenHeights = 0;
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
   * The band a window nested in a row draws its items within: `screenHeights`, except that while
   * the whole band has no leading side yet, each side the box can still move toward leads. A new
   * object only when a side changed.
   */
  public get nestedScreenHeights(): DrawnBandScreenHeights {
    return this.#nestedScreenHeights;
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

  /** A press on the box: it stops a fling, so the leading side's reach goes back to rest. */
  public notePress(): void {
    this.#flingScreenHeights = 0;
    this.widenFully();
  }

  /**
   * A geometry sample: one a scroll event published is the reader's own scroll, a fling's after
   * the hand let go among them, which sends no input, so it widens the band as input does, and
   * its travel since the last such sample sets the fling's reach. The transcript's own writes
   * publish theirs without an event, and only move the offset compared.
   */
  public observeGeometry(geometry: ScrollGeometry): void {
    const lastScrollTopPx = this.#lastScrollTopPx;
    this.#lastScrollTopPx = geometry.scrollTop;
    this.#isAtHead = geometry.scrollTop < SCROLL_GEOMETRY_EPSILON_PX;
    this.#isAtTail = geometry.isAtTail;
    if (geometry.inputAt === undefined || lastScrollTopPx === undefined) {
      // An end the box reached or left moves only the resting band of the windows in its rows.
      if (this.#updateNested()) {
        this.#publish();
      }
      return;
    }
    const lastInputAt = this.#lastInputAt;
    this.#lastInputAt = geometry.inputAt;
    this.#flingScreenHeights = flingScreenHeightsAfter(
      this.#flingScreenHeights,
      flingReachScreenHeights(
        Math.abs(geometry.scrollTop - lastScrollTopPx),
        lastInputAt === undefined ? undefined : geometry.inputAt - lastInputAt,
        geometry.viewportHeight,
      ),
    );
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

  /**
   * Brings `screenHeights` and `nestedScreenHeights` to the sides' widths, answering whether a
   * side of either changed.
   */
  #update(): boolean {
    const sideScreenHeights = this.#sideScreenHeights;
    const leadingScreenHeights = this.#leadingScreenHeights();
    const next: DrawnBandScreenHeights = {
      head: this.#leadingSide === "head" ? leadingScreenHeights : sideScreenHeights,
      tail: this.#leadingSide === "tail" ? leadingScreenHeights : sideScreenHeights,
    };
    const isChanged = !isSameBand(next, this.#screenHeights);
    if (isChanged) {
      this.#screenHeights = next;
    }
    return this.#updateNested() || isChanged;
  }

  /**
   * Brings `nestedScreenHeights` to `screenHeights`, or while the band has no leading side, to the
   * leading width on each side the box can still move toward; answers whether a side changed.
   */
  #updateNested(): boolean {
    const sideScreenHeights = this.#sideScreenHeights;
    const leadingScreenHeights = this.#leadingScreenHeights();
    const next: DrawnBandScreenHeights =
      this.#leadingSide === undefined
        ? {
            head: this.#isAtHead ? sideScreenHeights : leadingScreenHeights,
            tail: this.#isAtTail ? sideScreenHeights : leadingScreenHeights,
          }
        : this.#screenHeights;
    if (isSameBand(next, this.#nestedScreenHeights)) {
      return false;
    }
    this.#nestedScreenHeights = isSameBand(next, this.#screenHeights) ? this.#screenHeights : next;
    return true;
  }

  /**
   * The leading side's width: further than the others only once the band is whole, and further
   * still while a fling carries the box.
   */
  #leadingScreenHeights(): number {
    return this.#sideScreenHeights === TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS
      ? Math.max(TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS, this.#flingScreenHeights)
      : this.#sideScreenHeights;
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

/**
 * How far the box travels over the longest gap still read as one gesture, at the speed of
 * `travelPx` over `gapMs`, in screen heights; `0` for a gesture's first sample or a hidden box.
 */
function flingReachScreenHeights(
  travelPx: number,
  gapMs: number | undefined,
  viewportHeightPx: number,
): number {
  if (
    gapMs === undefined ||
    gapMs <= 0 ||
    gapMs > TRANSCRIPT_GESTURE_GAP_MS ||
    viewportHeightPx <= 0
  ) {
    return 0;
  }
  return (travelPx / gapMs) * (TRANSCRIPT_GESTURE_GAP_MS / viewportHeightPx);
}

/**
 * The fling's reach after a sample asking `reachScreenHeights`, a whole step up at once and down
 * only once the ask is two steps under, so a speed that wavers by a step redraws nothing.
 */
function flingScreenHeightsAfter(currentScreenHeights: number, reachScreenHeights: number): number {
  const step = TRANSCRIPT_FLING_BAND_STEP_SCREEN_HEIGHTS;
  const askedScreenHeights = Math.min(
    TRANSCRIPT_FLING_BAND_MAX_SCREEN_HEIGHTS,
    Math.ceil(reachScreenHeights / step) * step,
  );
  return askedScreenHeights > currentScreenHeights ||
    askedScreenHeights <= currentScreenHeights - 2 * step
    ? askedScreenHeights
    : currentScreenHeights;
}

function isSameBand(left: DrawnBandScreenHeights, right: DrawnBandScreenHeights): boolean {
  return left.head === right.head && left.tail === right.tail;
}
