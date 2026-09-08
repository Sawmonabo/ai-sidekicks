// The ledger's scroll chokepoint — the one module in the console that writes a
// scroll offset.
//
// `Spec-023 §Console Test Tiers` puts two of the architecture tier's tripwires here —
// "no `scrollTop` write outside the chokepoint, no `scrollIntoView`" — and
// `test/console/architecture/scroll-chokepoint.test.ts` is what makes them a fact rather
// than an intention: it reads every console module and fails on a second writer. THE
// REST IS THIS MODULE'S, because no committed document states it: one scroll controller
// per timeline pane, every caller a member of a closed caller union and named in the
// write, and glides replacing `scrollIntoView` everywhere.
//
// FOUR DECISIONS THIS MODULE MAKES, each of which that rule forces:
//
//   • **The caller is named in the write.** Not for a log — for arbitration. Four
//     subsystems want the offset (following, the reading anchor, find, replay), and
//     when two want it in one frame the loser has to be identifiable. A write from
//     an anonymous caller cannot be arbitrated, only overwritten.
//   • **Quantization is LEARNED, never assumed.** Skipping a "no-op" write is safe on a
//     display that rounds a written offset and wrong on one that does not, and nothing in
//     the platform reports which. `scroll-quantization.ts` answers it by writing and
//     reading back; this controller consults the answer and skips nothing while it is open.
//   • **Geometry is published, not polled.** Nothing here arms a timer, and every sample
//     says which number moved, because a box that changed size is not a reader who moved.
//     WHEN a sample is taken and off which surface is this module's; what one MEANS — the
//     derivation, the held sample, the replay, and which one is worth waking a subscriber
//     for — is `scroll-geometry-publisher.ts`', stated once, there.
//   • **Following costs no hit test.** The sample reads `scrollTop`, `clientHeight`, and
//     `scrollHeight` and nothing else — no row rect, no `elementFromPoint` — because those
//     three are the only reads a scroll event handler can afford at 60 Hz with four
//     lanes streaming.
//
// Row overflow measurement is batched pre-paint by `overflow-measurement-batch.ts` and a
// scroll triggers none of it, but the BOX is published the moment a resize is observed: a
// coalescing frame may make a row measurement late and may not make the height the window
// ranges against late. What stays here is which sink is installed, and what a pass reads.

import { type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import { type LedgerFrameCoordinator } from "../coordinator/frame-coordinator.js";
import {
  OverflowMeasurementBatch,
  type LedgerGeometry,
  type LedgerGeometryCause,
} from "../measurement/index.js";
import { type LedgerScrollCaller } from "./scroll-callers.js";
import {
  LedgerScrollFrameWrites,
  type LedgerScrollTargetComputation,
} from "./scroll-frame-writes.js";
import { LedgerGeometryPublisher } from "./scroll-geometry-publisher.js";
import { WholePixelQuantizationLearner } from "./scroll-quantization.js";

/** What one glide did, including the arm that did nothing. */
export interface LedgerScrollWrite {
  readonly caller: LedgerScrollCaller;
  readonly requestedScrollTop: number;
  readonly appliedScrollTop: number;
  /** True when the controller had confirmed quantization and the write was a no-op. */
  readonly wasSkipped: boolean;
}

/**
 * The surface the controller drives.
 *
 * Structural rather than `HTMLElement` so the unit tier can drive a surface whose
 * property reads it counts — which is how "no hit test per scroll event" is
 * checked rather than asserted. A real element satisfies it.
 */
export interface LedgerScrollSurface {
  scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Called once per batched overflow pass, with the geometry it was measured at. */
export type OverflowMeasurementSink = (geometry: LedgerGeometry) => void;

export interface LedgerScrollControllerOptions {
  readonly clock: ConsoleClock;
  /** Within this many pixels of the bottom counts as the tail. */
  readonly tailTolerancePx?: number;
}

export class LedgerScrollController {
  /** What a sample MEANS, and who is woken by one. One publisher per controller. */
  readonly #geometryPublisher: LedgerGeometryPublisher;
  readonly #writeCountByCaller = new Map<LedgerScrollCaller, number>();
  readonly #quantization = new WholePixelQuantizationLearner();
  readonly #overflowBatch: OverflowMeasurementBatch;
  /** Phase one of the frame: the reactive writes, ordered ahead of reveal work. */
  readonly #frameWrites: LedgerScrollFrameWrites;

  #surface: LedgerScrollSurface | undefined;
  #onSurfaceScroll: (() => void) | undefined;
  #overflowSink: OverflowMeasurementSink | undefined;
  #writeDepth = 0;
  #disposed = false;

  public constructor(options: LedgerScrollControllerOptions) {
    const controllerGeometry = (): LedgerGeometry | undefined =>
      this.#geometryPublisher.lastGeometry;
    this.#geometryPublisher = new LedgerGeometryPublisher({
      clock: options.clock,
      tailTolerancePx: options.tailTolerancePx,
    });
    this.#overflowBatch = new OverflowMeasurementBatch({
      clock: options.clock,
      runPass: () => {
        this.#runOverflowPass();
      },
      publishOnResize: () => {
        this.#publishGeometry("resize");
      },
    });
    this.#frameWrites = new LedgerScrollFrameWrites({
      get lastGeometry(): LedgerGeometry | undefined {
        return controllerGeometry();
      },
      glide: (caller, targetScrollTop) => {
        this.glideTo(caller, targetScrollTop);
      },
    });
  }

  /**
   * Take ownership of a scroll surface.
   *
   * Re-attaching detaches the previous surface first: a pane that re-mounts must
   * not leave a listener on a node React has already dropped.
   *
   * AND IT ARMS ITS OWN OVERFLOW PASS. That detach cancelled the frame the outgoing
   * attachment armed — right, since a pass on a detached controller samples nothing —
   * but the obligation was the LEDGER's and not the departed node's, and an heir that
   * inherited none waited on the next resize. Coalesced, so an attachment that is also
   * resized still costs one pass. The BOX is not what this covers: that is published on
   * the line above and again by `publishOnResize`, neither of which waits for a frame.
   */
  public attach(surface: LedgerScrollSurface): void {
    if (this.#disposed) {
      return;
    }
    this.detach();
    this.#surface = surface;
    const onScroll = (): void => {
      this.#publishGeometry("scroll");
    };
    this.#onSurfaceScroll = onScroll;
    surface.addEventListener("scroll", onScroll, { passive: true });
    this.#overflowBatch.observeResize(surface);
    this.#overflowBatch.observeFontLoading();
    this.#publishGeometry("scroll");
    this.#overflowBatch.request();
  }

  /**
   * Release the surface.
   *
   * Every read here is null-safe (`frame/ErrorSlot.tsx`'s teardown rule): teardown runs
   * on an unmount that may follow a failed attach, so the listener and everything the
   * batch holds may each be absent independently.
   */
  public detach(): void {
    const surface = this.#surface;
    const onScroll = this.#onSurfaceScroll;
    if (surface !== undefined && onScroll !== undefined) {
      surface.removeEventListener("scroll", onScroll);
    }
    this.#onSurfaceScroll = undefined;
    this.#surface = undefined;
    this.#overflowBatch.release();
  }

  /** Terminal. A disposed controller attaches nothing and arms nothing. */
  public dispose(): void {
    this.detach();
    this.#frameWrites.release();
    this.#overflowBatch.dispose();
    this.#geometryPublisher.clear();
    this.#disposed = true;
  }

  /**
   * Watch the geometry, and receive the last sample immediately.
   *
   * The replay is the publisher's, and the reason it exists is this controller's: a pane
   * mounted mid-stream needs to know whether it is at the tail before the next scroll
   * event, and polling for that is what the budgets forbid.
   */
  public subscribeToGeometry(sink: (geometry: LedgerGeometry) => void): Unsubscribe {
    return this.#geometryPublisher.subscribe(sink);
  }

  /** The last published sample, or `undefined` before the first attach. */
  public get geometry(): LedgerGeometry | undefined {
    return this.#geometryPublisher.lastGeometry;
  }

  /**
   * Move the ledger. The only `scrollTop` write in the console.
   *
   * Returns what happened rather than `void` so a caller can tell a skipped no-op
   * from a write that landed somewhere else — which is the difference between "the
   * anchor held" and "the browser clamped us to the end of the content".
   */
  public glideTo(
    caller: LedgerScrollCaller,
    targetScrollTop: number,
  ): LedgerScrollWrite | undefined {
    const surface = this.#surface;
    if (surface === undefined || this.#disposed) {
      return undefined;
    }
    const requestedScrollTop = this.#clampToContent(surface, targetScrollTop);
    const currentScrollTop = surface.scrollTop;
    this.#writeCountByCaller.set(caller, (this.#writeCountByCaller.get(caller) ?? 0) + 1);
    if (this.#quantization.isNoOpWrite(requestedScrollTop, currentScrollTop)) {
      return { caller, requestedScrollTop, appliedScrollTop: currentScrollTop, wasSkipped: true };
    }
    // The veto covers the WHOLE glide, publication included: a prune that landed
    // while subscribers were reacting to this write would change the content height
    // under the offset the write had just chosen.
    this.#writeDepth += 1;
    try {
      surface.scrollTop = requestedScrollTop;
      const appliedScrollTop = surface.scrollTop;
      this.#quantization.observe(requestedScrollTop, appliedScrollTop);
      this.#publishGeometry("scroll");
      return { caller, requestedScrollTop, appliedScrollTop, wasSkipped: false };
    } finally {
      this.#writeDepth -= 1;
    }
  }

  /** The glide that replaces `scrollIntoView` for the bottom of the log. */
  public glideToTail(caller: LedgerScrollCaller): LedgerScrollWrite | undefined {
    const surface = this.#surface;
    if (surface === undefined) {
      return undefined;
    }
    return this.glideTo(caller, surface.scrollHeight - surface.clientHeight);
  }

  /**
   * Join the frame's phase one, so this controller's reactive writes precede the
   * reveal and rail work that would move the ground under them. A SETTER because the
   * coordinator is the FEED's, one per frame, and this controller is constructed by
   * the viewport underneath it.
   */
  public adoptFrameCoordinator(frameCoordinator: LedgerFrameCoordinator): void {
    if (this.#disposed) {
      return;
    }
    this.#frameWrites.adopt(frameCoordinator);
  }

  // Consumed by T-023p-1C-2
  /**
   * Ask for a write in the next frame's phase one, computed against that frame's one
   * clean geometry sample.
   *
   * A gesture calls `glideTo` and lands in the frame the person acted in; a REACTIVE write
   * comes here. `scroll-frame-writes.ts` states why, and this returns whether it was taken.
   */
  public requestGlide(
    caller: LedgerScrollCaller,
    computeTarget: LedgerScrollTargetComputation,
  ): boolean {
    return this.#frameWrites.request(caller, computeTarget);
  }

  /**
   * Whether a prune may land right now.
   *
   * `window-cap.ts` gives the scroll controller a veto over prune, and this is it:
   * removing rows above the fold while a programmatic write is mid-flight changes the
   * content height under the offset that write just chose.
   */
  public vetoesPrune(): boolean {
    return this.#writeDepth > 0;
  }

  /**
   * Install the batched overflow-measurement pass.
   *
   * One sink per controller: two would be two passes over one layout, which is the
   * cost this batching exists to avoid.
   */
  public observeOverflow(sink: OverflowMeasurementSink): Unsubscribe {
    this.#overflowSink = sink;
    return () => {
      if (this.#overflowSink === sink) {
        this.#overflowSink = undefined;
      }
    };
  }

  /**
   * Ask for an overflow pass. Repeated calls inside one frame cost one pass.
   *
   * The coalescing is the batch's; what a pass READS is this controller's, which is
   * why the two live either side of this call.
   */
  public requestOverflowMeasurement(): void {
    this.#overflowBatch.request();
  }

  /** How many times a caller has written. Read by diagnostics and by tests. */
  public writeCount(caller: LedgerScrollCaller): number {
    return this.#writeCountByCaller.get(caller) ?? 0;
  }

  /**
   * Whether this display quantizes programmatic writes, or `undefined` while the
   * question is still open. Skipping is gated on `true`, never on `undefined`.
   */
  public get quantizesToWholePixels(): boolean | undefined {
    return this.#quantization.verdict;
  }

  #clampToContent(surface: LedgerScrollSurface, targetScrollTop: number): number {
    const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
    if (!Number.isFinite(targetScrollTop)) {
      // Fail closed rather than handing `NaN` to the platform, which silently
      // becomes zero and teleports the reader to the top of the log.
      return 0;
    }
    return Math.min(Math.max(0, targetScrollTop), maximum);
  }

  /**
   * Read the three numbers, hand them over, and return what was published.
   *
   * THE THREE READS ARE THE WHOLE OF THIS METHOD, and that is the claim: every derived
   * fact comes from them, so a row rect read here would be a hit test on the scroll
   * path, which this module forbids while following. What the three MEAN — the tail
   * arithmetic, the held sample, and whether a subscriber is woken — is the publisher's,
   * and `undefined` is returned for a controller with no surface because there is
   * nothing to read rather than nothing to say.
   */
  #publishGeometry(cause: LedgerGeometryCause): LedgerGeometry | undefined {
    const surface = this.#surface;
    if (surface === undefined) {
      return undefined;
    }
    return this.#geometryPublisher.publish(
      {
        scrollTop: surface.scrollTop,
        viewportHeight: surface.clientHeight,
        contentHeight: surface.scrollHeight,
      },
      cause,
    );
  }

  /**
   * One batched pass: sample once, publish it, and hand the same sample to the sink.
   *
   * PUBLISHED and not merely handed over: the emitter is the only way a viewport height
   * reaches the library's rect. One sample serves the batch, the anchor and the rect,
   * so the pass reads the surface exactly three times, and a pass on a DETACHED
   * controller samples nothing and calls nobody. The resize path no longer DEPENDS on
   * this publication — `publishOnResize` took that sample synchronously — and this one
   * is what the font-loading and explicit triggers publish through.
   */
  #runOverflowPass(): void {
    const geometry = this.#publishGeometry("resize");
    if (geometry !== undefined) {
      this.#overflowSink?.(geometry);
    }
  }
}
