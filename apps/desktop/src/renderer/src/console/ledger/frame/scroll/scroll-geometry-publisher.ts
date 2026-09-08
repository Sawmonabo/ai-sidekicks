// The ledger's geometry publication: what three numbers MEAN, and who is woken by them.
//
// SPLIT OUT OF `scroll-chokepoint.ts` ON THE SEAM THAT MODULE'S OWN TEXT NAMES.
// Its third decision — "Geometry is published, not polled: a replayable,
// instance-bound subscription" — is a whole job beside the two the chokepoint exists
// for, which are owning the surface and writing the offset. `geometry-sample.ts` had
// already named the reader of its comparison "a publisher"; this is that publisher,
// and it holds the emitter, the last sample, and the tolerance the two derived facts
// come out of.
//
// WHAT IS HERE AND WHAT IS NOT. Here: the derivation from the three sampled numbers,
// the held sample, the replay, and the rule about which sample is worth waking a
// subscriber for. Not here: the SURFACE. This module never reads a DOM property and
// never writes one — its caller reads `scrollTop`, `clientHeight` and `scrollHeight`
// exactly once each and hands the three over, which is what keeps "the sample reads
// three properties and no fourth" a claim about the module that does the reading, and
// what keeps the one `scrollTop` write in the console in the one module the
// architecture tier pins by path.
//
// AND IT TAKES A READING RATHER THAN A SURFACE for the same reason a cycle would
// otherwise close: `LedgerScrollSurface` is the chokepoint's own declaration, and a
// publisher that took one would have to import the module that imports it —
// `scroll-callers.ts` records the same shape one seam over.

import { Emitter, type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import { LEDGER_GEOMETRY_EPSILON_PX, LEDGER_TAIL_TOLERANCE_PX } from "../frame-bounds.js";
import {
  sameSampledGeometry,
  type LedgerGeometry,
  type LedgerGeometryCause,
} from "../measurement/index.js";

/**
 * The three numbers a surface read produces, before anything is derived from them.
 *
 * The SAMPLED members of `LedgerGeometry` and nothing else: the two derived facts are
 * this module's to compute and the provenance pair is its to stamp, so a caller that
 * could supply either would be a second answer to a question decided here.
 */
export interface LedgerGeometryReading {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}

export interface LedgerGeometryPublisherOptions {
  readonly clock: ConsoleClock;
  /**
   * Within this many pixels of the bottom counts as the tail.
   *
   * Explicitly `| undefined` because the controller FORWARDS its own optional rather
   * than resolving it — the default belongs to the module that does the arithmetic, so
   * under `exactOptionalPropertyTypes` an absent tolerance has to be a value this
   * option accepts rather than a key the caller has to conditionally omit.
   */
  readonly tailTolerancePx?: number | undefined;
}

/**
 * Holds the ledger's last geometry sample and wakes the subscribers a new one is news for.
 *
 * One per scroll controller. A class rather than a closure because the held sample,
 * the emitter and the tolerance are one object's state and the module level is not a
 * place to keep them.
 */
export class LedgerGeometryPublisher {
  readonly #clock: ConsoleClock;
  readonly #tailTolerancePx: number;
  readonly #emitter = new Emitter<LedgerGeometry>("ledger geometry");

  #lastGeometry: LedgerGeometry | undefined;

  public constructor(options: LedgerGeometryPublisherOptions) {
    this.#clock = options.clock;
    this.#tailTolerancePx = options.tailTolerancePx ?? LEDGER_TAIL_TOLERANCE_PX;
  }

  /** The last published sample, or `undefined` before the first publication. */
  public get lastGeometry(): LedgerGeometry | undefined {
    return this.#lastGeometry;
  }

  /**
   * Watch the geometry, and receive the last sample immediately.
   *
   * The replay is the point: a pane mounted mid-stream needs to know whether it is at the
   * tail before the next scroll event, and polling for that is what the budgets forbid.
   */
  public subscribe(sink: (geometry: LedgerGeometry) => void): Unsubscribe {
    const unsubscribe = this.#emitter.subscribe(sink);
    const lastGeometry = this.#lastGeometry;
    if (lastGeometry !== undefined) {
      sink(lastGeometry);
    }
    return unsubscribe;
  }

  /**
   * Derive a sample from one reading, record it, and emit it if it says anything new.
   *
   * The emit feeds the anchor and both of the library's observers, so a sample identical
   * to the one they already hold must not wake them. The compare is the three sampled
   * numbers within the epsilon this frame already owns; `sampledAt` and the cause are
   * provenance and decide nothing. Returns the sample either way, so a caller does not
   * take a second reading to find out what was published.
   */
  public publish(reading: LedgerGeometryReading, cause: LedgerGeometryCause): LedgerGeometry {
    const distanceFromTailPx = Math.max(
      0,
      reading.contentHeight - reading.viewportHeight - reading.scrollTop,
    );
    const geometry: LedgerGeometry = {
      scrollTop: reading.scrollTop,
      viewportHeight: reading.viewportHeight,
      contentHeight: reading.contentHeight,
      distanceFromTailPx,
      isAtTail: distanceFromTailPx <= this.#tailTolerancePx + LEDGER_GEOMETRY_EPSILON_PX,
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
   * Drop every subscriber.
   *
   * SUBSCRIBERS ONLY, and the held sample deliberately stays: a disposed controller
   * must wake nobody, and the last sample is the answer to what the pane's box WAS,
   * which a diagnostic reading it afterwards is entitled to. Nothing republishes it —
   * a subscription taken after this replays it and then hears nothing, because the
   * controller that fed this publisher has no surface to sample.
   */
  public clear(): void {
    this.#emitter.clear();
  }
}
