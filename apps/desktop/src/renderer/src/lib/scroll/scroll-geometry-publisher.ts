// Geometry publication: derives the tail facts from three sampled numbers, holds the last
// sample, resends it to new subscribers, and wakes them only for a sample that says something new.
// It takes a reading rather than the scroll container, so it holds no element and is driven by
// numbers alone.

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { type Clock } from "@renderer/lib/clock.js";
import {
  SCROLL_GEOMETRY_EPSILON_PX,
  sameSampledGeometry,
  type ScrollGeometry,
  type GeometryChangeCause,
} from "./geometry-sample.js";

/**
 * Tolerance, in pixels, within which the viewport counts as sitting at the tail.
 *
 * An exact test flickers between following and reading on every frame of a stream, because of
 * sub-pixel scroll positions and fractional row heights. One line's leading is the smallest band
 * rounding cannot cross.
 */
export const SCROLL_TAIL_TOLERANCE_PX = 24;

/**
 * The three numbers a scroll container read produces, before anything is derived.
 * Only the sampled members of `ScrollGeometry`; the derived and provenance members are
 * this module's to compute.
 */
export interface ScrollGeometryReading {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}

/** Construction inputs for a `ScrollGeometryPublisher`. */
export interface ScrollGeometryPublisherOptions {
  readonly clock: Clock;
  /**
   * Within this many pixels of the bottom counts as the tail.
   * Explicitly `| undefined` so the controller can forward its own optional under
   * `exactOptionalPropertyTypes`.
   */
  readonly tailTolerancePx?: number | undefined;
}

/**
 * Holds a scroll container's last geometry sample and wakes the subscribers a new one is news for.
 * One per scroll controller.
 */
export class ScrollGeometryPublisher {
  readonly #clock: Clock;
  readonly #tailTolerancePx: number;
  readonly #emitter = new Emitter<ScrollGeometry>("scroll geometry");

  #lastGeometry: ScrollGeometry | undefined;

  public constructor(options: ScrollGeometryPublisherOptions) {
    this.#clock = options.clock;
    this.#tailTolerancePx = options.tailTolerancePx ?? SCROLL_TAIL_TOLERANCE_PX;
  }

  /** The last published sample, or `undefined` before the first publication. */
  public get lastGeometry(): ScrollGeometry | undefined {
    return this.#lastGeometry;
  }

  /**
   * Watch the geometry; the sink receives the last sample immediately, so a pane mounted
   * mid-stream knows whether it is at the tail without polling.
   */
  public subscribe(sink: (geometry: ScrollGeometry) => void): Unsubscribe {
    const unsubscribe = this.#emitter.subscribe(sink);
    const lastGeometry = this.#lastGeometry;
    if (lastGeometry !== undefined) {
      sink(lastGeometry);
    }
    return unsubscribe;
  }

  /**
   * Derive a sample from one reading, record it, and emit it if it says anything new.
   * A sample equal to the held one (three numbers within the epsilon; `sampledAt` and cause
   * are provenance) must not wake the anchor and the virtualizer observers. Returns the
   * sample either way.
   */
  public publish(reading: ScrollGeometryReading, cause: GeometryChangeCause): ScrollGeometry {
    const distanceFromTailPx = Math.max(
      0,
      reading.contentHeight - reading.viewportHeight - reading.scrollTop,
    );
    const geometry: ScrollGeometry = {
      scrollTop: reading.scrollTop,
      viewportHeight: reading.viewportHeight,
      contentHeight: reading.contentHeight,
      distanceFromTailPx,
      isAtTail: distanceFromTailPx <= this.#tailTolerancePx + SCROLL_GEOMETRY_EPSILON_PX,
      sampledAt: this.#clock.now(),
      cause,
    };
    const previous = this.#lastGeometry;
    this.#lastGeometry = geometry;
    if (previous !== undefined && sameSampledGeometry(previous, geometry)) {
      return geometry;
    }
    this.#emitter.emit(geometry);
    return geometry;
  }

  /**
   * Drop every subscriber. The held sample stays: a disposed controller must wake nobody,
   * and a later subscription is resent the last sample and then hears nothing.
   */
  public clear(): void {
    this.#emitter.clear();
  }
}
