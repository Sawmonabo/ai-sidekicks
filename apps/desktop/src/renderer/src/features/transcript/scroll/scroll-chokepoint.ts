// The only module that writes a transcript scroll offset; each write names its caller so
// competing writers can be arbitrated.
// Geometry is published, never polled, from three reads (`scrollTop`, `clientHeight`,
// `scrollHeight`) and no hit test. A no-op write is skipped only once the display is known
// to round offsets.

import { type Clock } from "@renderer/lib/clock.js";
import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { type AnimationFrameCoordinator } from "../animation-frame-coordinator.js";
import { OverflowMeasurementBatch } from "../viewport/overflow-measurement-batch.js";
import { type ScrollGeometry, type GeometryChangeCause } from "./geometry-sample.js";
import { type ScrollCaller } from "./scroll-callers.js";
import { ScrollFrameWrites, type ScrollTargetComputation } from "./scroll-frame-writes.js";
import { ScrollGeometryPublisher } from "./scroll-geometry-publisher.js";
import { WholePixelQuantizationLearner } from "./scroll-quantization.js";

/** What one glide did, including the arm that did nothing. */
export interface ScrollWrite {
  readonly caller: ScrollCaller;
  readonly requestedScrollTop: number;
  readonly appliedScrollTop: number;
  /** True when quantization was confirmed and the write was a no-op. */
  readonly wasSkipped: boolean;
}

/** Called once per batched overflow pass, with the geometry it was measured at. */
export type OverflowMeasurementSink = (geometry: ScrollGeometry) => void;

/** Construction inputs for a `ScrollController`. */
export interface ScrollControllerOptions {
  readonly clock: Clock;
  /** Within this many pixels of the bottom counts as the tail. */
  readonly tailTolerancePx?: number;
}

/** Drives one transcript pane's scroll container; every programmatic write goes through it. */
export class ScrollController {
  readonly #geometryPublisher: ScrollGeometryPublisher;
  readonly #writeCountByCaller = new Map<ScrollCaller, number>();
  readonly #quantization = new WholePixelQuantizationLearner();
  readonly #overflowBatch: OverflowMeasurementBatch;
  /** Reactive writes run in phase one of the frame, ahead of reveal work. */
  readonly #frameWrites: ScrollFrameWrites;

  #scrollContainer: HTMLElement | undefined;
  #onContainerScroll: (() => void) | undefined;
  #overflowSink: OverflowMeasurementSink | undefined;
  #writeDepth = 0;
  #disposed = false;

  public constructor(options: ScrollControllerOptions) {
    const controllerGeometry = (): ScrollGeometry | undefined =>
      this.#geometryPublisher.lastGeometry;
    this.#geometryPublisher = new ScrollGeometryPublisher({
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
    this.#frameWrites = new ScrollFrameWrites({
      get lastGeometry(): ScrollGeometry | undefined {
        return controllerGeometry();
      },
      glide: (caller, targetScrollTop) => {
        this.glideTo(caller, targetScrollTop);
      },
    });
  }

  /**
   * Take ownership of a scroll container, detaching any previous one first.
   *
   * Arms an overflow pass too: the detach canceled the pass the previous attachment armed,
   * and the new container would otherwise wait for its first resize.
   */
  public attach(scrollContainer: HTMLElement): void {
    if (this.#disposed) {
      return;
    }
    this.detach();
    this.#scrollContainer = scrollContainer;
    const onScroll = (): void => {
      this.#publishGeometry("scroll");
    };
    this.#onContainerScroll = onScroll;
    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    this.#overflowBatch.observeResize(scrollContainer);
    this.#overflowBatch.observeFontLoading();
    this.#publishGeometry("scroll");
    this.#overflowBatch.request();
  }

  /**
   * Release the scroll container.
   *
   * Safe after a failed attach: the listener and the batch state may each be absent.
   */
  public detach(): void {
    const scrollContainer = this.#scrollContainer;
    const onScroll = this.#onContainerScroll;
    if (scrollContainer !== undefined && onScroll !== undefined) {
      scrollContainer.removeEventListener("scroll", onScroll);
    }
    this.#onContainerScroll = undefined;
    this.#scrollContainer = undefined;
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
   * Watch the geometry; the sink receives the last sample immediately, so a pane mounted
   * mid-stream knows whether it is at the tail without polling.
   */
  public subscribeToGeometry(sink: (geometry: ScrollGeometry) => void): Unsubscribe {
    return this.#geometryPublisher.subscribe(sink);
  }

  /** The last published sample, or `undefined` before the first attach. */
  public get geometry(): ScrollGeometry | undefined {
    return this.#geometryPublisher.lastGeometry;
  }

  /**
   * Move the transcript; the only `scrollTop` write. The result tells a skipped no-op from a
   * write the browser clamped somewhere else.
   */
  public glideTo(caller: ScrollCaller, targetScrollTop: number): ScrollWrite | undefined {
    const scrollContainer = this.#scrollContainer;
    if (scrollContainer === undefined || this.#disposed) {
      return undefined;
    }
    const requestedScrollTop = this.#clampToContent(scrollContainer, targetScrollTop);
    const currentScrollTop = scrollContainer.scrollTop;
    this.#writeCountByCaller.set(caller, (this.#writeCountByCaller.get(caller) ?? 0) + 1);
    if (this.#quantization.isNoOpWrite(requestedScrollTop, currentScrollTop)) {
      return { caller, requestedScrollTop, appliedScrollTop: currentScrollTop, wasSkipped: true };
    }
    // The veto covers the whole glide, publication included: a prune landing while
    // subscribers react would change the content height under the chosen offset.
    this.#writeDepth += 1;
    try {
      scrollContainer.scrollTop = requestedScrollTop;
      const appliedScrollTop = scrollContainer.scrollTop;
      this.#quantization.observe(requestedScrollTop, appliedScrollTop);
      this.#publishGeometry("scroll");
      return { caller, requestedScrollTop, appliedScrollTop, wasSkipped: false };
    } finally {
      this.#writeDepth -= 1;
    }
  }

  /** Glide to the bottom of the log. */
  public glideToTail(caller: ScrollCaller): ScrollWrite | undefined {
    const scrollContainer = this.#scrollContainer;
    if (scrollContainer === undefined) {
      return undefined;
    }
    return this.glideTo(caller, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  }

  /**
   * Join the frame's phase one so this controller's reactive writes precede reveal work.
   * A setter because the feed owns the coordinator and the viewport constructs this controller.
   */
  public adoptFrameCoordinator(frameCoordinator: AnimationFrameCoordinator): void {
    if (this.#disposed) {
      return;
    }
    this.#frameWrites.adopt(frameCoordinator);
  }

  /**
   * Ask for a write in the next frame's phase one, computed against that frame's geometry
   * sample. Gestures call `glideTo`; reactive writes come here. Returns whether it was taken.
   */
  public requestGlide(caller: ScrollCaller, computeTarget: ScrollTargetComputation): boolean {
    return this.#frameWrites.request(caller, computeTarget);
  }

  /**
   * Whether a prune must wait: removing rows above the fold mid-write would change the
   * content height under the chosen offset.
   */
  public vetoesPrune(): boolean {
    return this.#writeDepth > 0;
  }

  /**
   * Install the batched overflow-measurement pass. One sink per controller: two would be
   * two passes over one layout.
   */
  public observeOverflow(sink: OverflowMeasurementSink): Unsubscribe {
    this.#overflowSink = sink;
    return () => {
      if (this.#overflowSink === sink) {
        this.#overflowSink = undefined;
      }
    };
  }

  /** Ask for an overflow pass; repeated calls inside one frame cost one pass. */
  public requestOverflowMeasurement(): void {
    this.#overflowBatch.request();
  }

  /** How many times a caller has written. */
  public writeCount(caller: ScrollCaller): number {
    return this.#writeCountByCaller.get(caller) ?? 0;
  }

  #clampToContent(scrollContainer: HTMLElement, targetScrollTop: number): number {
    const maximum = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    if (!Number.isFinite(targetScrollTop)) {
      // Fail closed: the platform silently turns `NaN` into zero, which would teleport the
      // reader to the top of the log.
      return 0;
    }
    return Math.min(Math.max(0, targetScrollTop), maximum);
  }

  /**
   * Read the three numbers, publish them, and return the sample; `undefined` when no
   * container is attached. A row rect read here would put a hit test on the scroll path.
   */
  #publishGeometry(cause: GeometryChangeCause): ScrollGeometry | undefined {
    const scrollContainer = this.#scrollContainer;
    if (scrollContainer === undefined) {
      return undefined;
    }
    return this.#geometryPublisher.publish(
      {
        scrollTop: scrollContainer.scrollTop,
        viewportHeight: scrollContainer.clientHeight,
        contentHeight: scrollContainer.scrollHeight,
      },
      cause,
    );
  }

  /**
   * One batched pass: sample once, publish, and hand the same sample to the sink.
   * Publishing matters because the emitter is the only way the viewport height reaches
   * the virtualizer; a detached controller samples nothing.
   */
  #runOverflowPass(): void {
    const geometry = this.#publishGeometry("resize");
    if (geometry !== undefined) {
      this.#overflowSink?.(geometry);
    }
  }
}
