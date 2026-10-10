// The only module that writes a scroll offset, the transcript's and every windowed list's; each
// write names its caller so competing writers can be arbitrated.
// Geometry is published, never polled, and with no hit test. A container attached with its
// content height (a virtualizer's total size) costs a scroll event one read, `scrollTop`: the
// viewport height comes from the resize observation. One attached without it reads
// `clientHeight` and `scrollHeight` beside the offset. A no-op write is skipped only once the
// display is known to round offsets.

import { type Clock } from "#renderer/lib/clock.js";
import { prefersReducedMotion } from "#renderer/lib/reduced-motion.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { OverflowMeasurementBatch } from "./overflow-measurement-batch.js";
import { type ScrollGeometry, type GeometryChangeCause } from "./geometry/sample.js";
import { type ScrollCaller } from "./callers.js";
import {
  ScrollFrameWrites,
  type ScrollFrameScheduler,
  type ScrollTargetComputation,
} from "./frame-writes.js";
import { ScrollGeometryPublisher, type ScrollGeometryReading } from "./geometry/publisher.js";
import { WholePixelQuantizationLearner } from "./quantization.js";

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

/** Drives one scroll container; every programmatic write to it goes through here. */
export class ScrollController {
  readonly #geometryPublisher: ScrollGeometryPublisher;
  readonly #writeCountByCaller = new Map<ScrollCaller, number>();
  readonly #quantization = new WholePixelQuantizationLearner();
  readonly #overflowBatch: OverflowMeasurementBatch;
  /** Reactive writes run in phase one of the frame, ahead of reveal work. */
  readonly #frameWrites: ScrollFrameWrites;

  #scrollContainer: HTMLElement | undefined;
  /** The caller's content height, read in place of `scrollHeight`; absent, the element's are. */
  #contentHeight: (() => number) | undefined;
  /**
   * The viewport height read beside a supplied content height: `clientHeight` on attach, then each
   * resize observation's content box, which is `clientHeight` less the vertical padding (both
   * leave out a horizontal scrollbar), so a scroll event reads no box.
   */
  #viewportHeightPx = 0;
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
      publishOnResize: (contentBoxHeightPx) => {
        this.#viewportHeightPx = contentBoxHeightPx;
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
   * Take ownership of a scroll container, detaching any previous one first, and arm an overflow
   * pass, since the detach canceled the one the previous attachment armed.
   *
   * `contentHeight`, in CSS pixels, stands in for `scrollHeight` and the observed content box for
   * `clientHeight`, so a scroll event reads only `scrollTop`. It measures the content inside the
   * container's vertical padding, which the content box leaves out too.
   */
  public attach(scrollContainer: HTMLElement, contentHeight?: () => number): void {
    if (this.#disposed) {
      return;
    }
    this.detach();
    this.#scrollContainer = scrollContainer;
    this.#contentHeight = contentHeight;
    // Until the first resize observation, which the platform delivers before the next paint.
    this.#viewportHeightPx = scrollContainer.clientHeight;
    const onScroll = (): void => {
      this.#publishGeometry("scroll");
    };
    this.#onContainerScroll = onScroll;
    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    this.#overflowBatch.observeResize(scrollContainer);
    this.#overflowBatch.observeFontLoading(scrollContainer);
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
    this.#contentHeight = undefined;
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
   * Move the content; the only `scrollTop` write. The result tells a skipped no-op from a
   * write the browser clamped somewhere else.
   */
  public glideTo(caller: ScrollCaller, targetScrollTop: number): ScrollWrite | undefined {
    const scrollContainer = this.#scrollContainer;
    if (scrollContainer === undefined || this.#disposed) {
      return undefined;
    }
    const maximumScrollTop = this.#maximumScrollTop(scrollContainer);
    const requestedScrollTop = clampToContent(targetScrollTop, maximumScrollTop);
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
      // A supplied content height knows the platform's whole-pixel maximum only to within a
      // pixel, so a write that near the edge may have been clamped, and a clamp reads as rounding.
      const isNearSuppliedEdge =
        this.#contentHeight !== undefined && requestedScrollTop > maximumScrollTop - 1;
      if (!isNearSuppliedEdge) {
        this.#quantization.observe(requestedScrollTop, appliedScrollTop);
      }
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
    return this.glideTo(caller, this.#maximumScrollTop(scrollContainer));
  }

  /**
   * Join the frame's phase one so this controller's reactive writes precede reveal work.
   * A setter because the feed owns the scheduler and the viewport constructs this controller.
   */
  public adoptFrameScheduler(frameScheduler: ScrollFrameScheduler): void {
    if (this.#disposed) {
      return;
    }
    this.#frameWrites.adopt(frameScheduler);
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

  #maximumScrollTop(scrollContainer: HTMLElement): number {
    const { contentHeight, viewportHeight } = this.#readHeights(scrollContainer);
    return Math.max(0, contentHeight - viewportHeight);
  }

  /**
   * The content and viewport heights: the supplied content height over the observed viewport,
   * which reads no element, or else the element's `scrollHeight` and `clientHeight`.
   */
  #readHeights(scrollContainer: HTMLElement): Omit<ScrollGeometryReading, "scrollTop"> {
    const contentHeight = this.#contentHeight;
    if (contentHeight === undefined) {
      return {
        viewportHeight: scrollContainer.clientHeight,
        contentHeight: scrollContainer.scrollHeight,
      };
    }
    const viewportHeight = this.#viewportHeightPx;
    // `scrollHeight` is never smaller than the viewport, so neither is what stands in for it.
    return { viewportHeight, contentHeight: Math.max(contentHeight(), viewportHeight) };
  }

  /**
   * Read the offset and the heights, publish them, and return the sample; `undefined` when no
   * container is attached. A row rect read here would put a hit test on the scroll path.
   */
  #publishGeometry(cause: GeometryChangeCause): ScrollGeometry | undefined {
    const scrollContainer = this.#scrollContainer;
    if (scrollContainer === undefined) {
      return undefined;
    }
    return this.#geometryPublisher.publish(
      { scrollTop: scrollContainer.scrollTop, ...this.#readHeights(scrollContainer) },
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

/**
 * Scrolls `container` along `axis` to `offset` CSS pixels, clamped to its content, and answers
 * the offset it reached. The reorder drag's edge scroll is its one caller: a drag carries the
 * list it moves in near an edge and holds no `ScrollController` for that list.
 */
export function scrollForReorderDrag(
  container: Element,
  axis: "horizontal" | "vertical",
  offset: number,
): number {
  if (axis === "horizontal") {
    const maximum = Math.max(0, container.scrollWidth - container.clientWidth);
    container.scrollLeft = Math.min(Math.max(0, offset), maximum);
    return container.scrollLeft;
  }
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(Math.max(0, offset), maximum);
  return container.scrollTop;
}

/**
 * Scrolls `container` sideways the least distance that brings `item` wholly into view, gliding
 * unless its window asks for reduced motion. The pane block is its one caller: a pane just opened
 * past the block's visible width is brought into view, and the block holds no `ScrollController`.
 * Throws for a container whose document has no window.
 */
export function revealInRow(container: Element, item: Element): void {
  const view = container.ownerDocument.defaultView;
  if (view === null) {
    throw new Error("A row was scrolled in a document with no window.");
  }
  const containerBox = container.getBoundingClientRect();
  const itemBox = item.getBoundingClientRect();
  const leftOverflow = itemBox.left - containerBox.left;
  const rightOverflow = itemBox.right - containerBox.right;
  // An item wider than the view shows its start, where its header is.
  const shift =
    leftOverflow < 0 || itemBox.width > containerBox.width
      ? leftOverflow
      : Math.max(0, rightOverflow);
  if (shift === 0) {
    return;
  }
  container.scrollTo({
    left: container.scrollLeft + shift,
    behavior: prefersReducedMotion(view) ? "instant" : "smooth",
  });
}

function clampToContent(targetScrollTop: number, maximumScrollTop: number): number {
  if (!Number.isFinite(targetScrollTop)) {
    // Fail closed: the platform silently turns `NaN` into zero, which would teleport the reader
    // to the top of the log.
    return 0;
  }
  return Math.min(Math.max(0, targetScrollTop), maximumScrollTop);
}
