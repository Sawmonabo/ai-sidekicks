// The only module that writes a scroll offset, the transcript's and every windowed list's; each
// write names its caller so competing writers can be arbitrated.
// Geometry is published, never polled, and with no hit test. A container attached with its
// content height (a virtualizer's total size) costs a scroll event one read, `scrollTop`: the
// viewport height comes from the resize observation. One attached without it reads
// `clientHeight` and `scrollHeight` beside the offset. A write to the offset the box stands at is
// skipped, and one that rounding would undo only once the display is known to round offsets; a
// write the frame repeats reads where the box stands from the last sample, so it reads nothing.

import { type Clock } from "#renderer/lib/clock.js";
import { prefersReducedMotion } from "#renderer/lib/reduced-motion.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { OverflowMeasurementBatch } from "./overflow-measurement-batch.js";
import { type ScrollGeometry, type GeometryChangeCause } from "./geometry/sample.js";
import { type ScrollCaller } from "./callers.js";
import { EasedGlide, type GlideMotion } from "./eased-glide.js";
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

/** What one write to a container no `ScrollController` drives did: its caller and its offsets. */
export interface ScrollOffsetWrite {
  readonly caller: ScrollCaller;
  readonly axis: "horizontal" | "vertical";
  readonly requestedOffset: number;
  readonly appliedOffset: number;
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
  /** The one eased glide, a write a frame through the same phase. */
  readonly #easedGlide: EasedGlide;

  #scrollContainer: HTMLElement | undefined;
  /** The caller's content height, read in place of `scrollHeight`; absent, the element's are. */
  #contentHeight: (() => number) | undefined;
  /**
   * The viewport height read beside a supplied content height: `clientHeight` on attach, then each
   * resize observation's content box, which is `clientHeight` less the vertical padding (both
   * leave out a horizontal scrollbar), so a scroll event reads no box.
   */
  #viewportHeightPx = 0;
  #onContainerScroll: ((event: Event) => void) | undefined;
  #overflowSink: OverflowMeasurementSink | undefined;
  #writeDepth = 0;
  /** How many follow holds are unreleased; while any is, a write that follows the tail drops. */
  #followHoldCount = 0;
  #disposed = false;

  public constructor(options: ScrollControllerOptions) {
    const controllerGeometry = (): ScrollGeometry | undefined =>
      this.#geometryPublisher.lastGeometry;
    this.#geometryPublisher = new ScrollGeometryPublisher({
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
    this.#easedGlide = new EasedGlide({
      now: () => options.clock.now(),
      requestFrame: (caller, computeTarget) => this.#frameWrites.request(caller, computeTarget),
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
    const onScroll = (event: Event): void => {
      this.#publishGeometry("scroll", event.timeStamp);
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
    this.#easedGlide.stop();
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
    if (scrollContainer === undefined || this.#disposed || this.#isHeldFollowWrite(caller)) {
      return undefined;
    }
    const maximumScrollTop = this.#maximumScrollTopOf(scrollContainer);
    const requestedScrollTop = clampToContent(targetScrollTop, maximumScrollTop);
    // A write the frame repeats reads the held sample's offset, not the element's: reading or
    // writing `scrollTop` lays out what the caller just changed, and a write that moves nothing
    // needs no layout. A sample can trail the box until its scroll event, which moves the next
    // repeat's target too; a write asked once is never asked again, so it reads the box.
    const heldScrollTop = isAskedOnce(caller)
      ? undefined
      : this.#geometryPublisher.lastGeometry?.scrollTop;
    const currentScrollTop = heldScrollTop ?? scrollContainer.scrollTop;
    this.#writeCountByCaller.set(caller, (this.#writeCountByCaller.get(caller) ?? 0) + 1);
    if (
      requestedScrollTop === currentScrollTop ||
      this.#quantization.isNoOpWrite(requestedScrollTop, currentScrollTop)
    ) {
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
    const maximumScrollTop = this.maximumScrollTop();
    return maximumScrollTop === undefined ? undefined : this.glideTo(caller, maximumScrollTop);
  }

  /**
   * The offset that shows the content's end, read now from the supplied content height or else
   * the element, so every caller aiming at the tail aims where a write is clamped; `undefined`
   * while no container is attached.
   */
  public maximumScrollTop(): number | undefined {
    const scrollContainer = this.#scrollContainer;
    return scrollContainer === undefined ? undefined : this.#maximumScrollTopOf(scrollContainer);
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
   * Ease toward the offset `computeTarget` answers each frame, one write a frame in phase one,
   * over `motion`: a target that moves mid-glide restarts the ease from where the box stands, and
   * a target behind the box is placed at once. A glide for the same caller already under way takes
   * the new target. Answers whether it runs, which it cannot before a frame is adopted.
   */
  public easeTo(
    caller: ScrollCaller,
    computeTarget: ScrollTargetComputation,
    motion: GlideMotion,
  ): boolean {
    if (this.#isHeldFollowWrite(caller)) {
      return false;
    }
    return this.#easedGlide.start(caller, computeTarget, motion);
  }

  /**
   * Holds every write that follows the tail until the answered release is called: each one is
   * dropped, not queued, and a glide after arriving text ends where the box stands, so a layout a
   * person is dragging moves nothing under their hand. Landing the follower again on release is
   * the caller's.
   */
  public holdFollow(): () => void {
    this.#followHoldCount += 1;
    const glideCaller = this.#easedGlide.caller;
    if (glideCaller !== undefined && isFollowWrite(glideCaller)) {
      this.#easedGlide.stop();
    }
    let isReleased = false;
    return () => {
      if (!isReleased) {
        isReleased = true;
        this.#followHoldCount -= 1;
      }
    };
  }

  /** End an eased glide where the box stands. */
  public stopEasing(): void {
    this.#easedGlide.stop();
  }

  /** Whether an eased glide is under way. */
  public get isEasing(): boolean {
    return this.#easedGlide.isGliding;
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

  #isHeldFollowWrite(caller: ScrollCaller): boolean {
    return this.#followHoldCount > 0 && isFollowWrite(caller);
  }

  #maximumScrollTopOf(scrollContainer: HTMLElement): number {
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
  #publishGeometry(cause: GeometryChangeCause, inputAt?: number): ScrollGeometry | undefined {
    const scrollContainer = this.#scrollContainer;
    if (scrollContainer === undefined) {
      return undefined;
    }
    return this.#geometryPublisher.publish(
      { scrollTop: scrollContainer.scrollTop, ...this.#readHeights(scrollContainer) },
      cause,
      inputAt,
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
 * Scrolls `container` along `axis` to `offset` CSS pixels, clamped to its content, for `caller`,
 * and answers what it wrote. A reorder drag's edge scroll calls it: a drag carries the list it
 * moves in near an edge and holds no `ScrollController` for that list.
 */
export function scrollForReorderDrag(
  container: Element,
  axis: "horizontal" | "vertical",
  offset: number,
  caller: ScrollCaller,
): ScrollOffsetWrite {
  if (axis === "horizontal") {
    const maximum = Math.max(0, container.scrollWidth - container.clientWidth);
    const requestedOffset = Math.min(Math.max(0, offset), maximum);
    container.scrollLeft = requestedOffset;
    return { caller, axis, requestedOffset, appliedOffset: container.scrollLeft };
  }
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  const requestedOffset = Math.min(Math.max(0, offset), maximum);
  container.scrollTop = requestedOffset;
  return { caller, axis, requestedOffset, appliedOffset: container.scrollTop };
}

/**
 * Scrolls `container` sideways the least distance that brings `item` wholly into view, for
 * `caller`, gliding unless its window asks for reduced motion, and answers what it asked for;
 * `undefined` when the item is already in view. The pane block calls it, and holds no
 * `ScrollController`. Throws for a container whose document has no window.
 */
export function revealInRow(
  container: Element,
  item: Element,
  caller: ScrollCaller,
): ScrollOffsetWrite | undefined {
  return revealAlong(container, item, "horizontal", caller);
}

/**
 * Scrolls `container` up or down the least distance that brings `item` wholly into view, as
 * {@link revealInRow} does sideways. A screen with no `ScrollController` calls it to bring one
 * control back into view. Throws for a container whose document has no window.
 */
export function revealInColumn(
  container: Element,
  item: Element,
  caller: ScrollCaller,
): ScrollOffsetWrite | undefined {
  return revealAlong(container, item, "vertical", caller);
}

function revealAlong(
  container: Element,
  item: Element,
  axis: ScrollOffsetWrite["axis"],
  caller: ScrollCaller,
): ScrollOffsetWrite | undefined {
  const view = container.ownerDocument.defaultView;
  if (view === null) {
    throw new Error("An item was revealed in a document with no window.");
  }
  const containerBox = container.getBoundingClientRect();
  const itemBox = item.getBoundingClientRect();
  const isHorizontal = axis === "horizontal";
  const startOverflow = isHorizontal
    ? itemBox.left - containerBox.left
    : itemBox.top - containerBox.top;
  const endOverflow = isHorizontal
    ? itemBox.right - containerBox.right
    : itemBox.bottom - containerBox.bottom;
  const itemLength = isHorizontal ? itemBox.width : itemBox.height;
  const containerLength = isHorizontal ? containerBox.width : containerBox.height;
  // An item longer than the view shows its start, where its header is.
  const shift =
    startOverflow < 0 || itemLength > containerLength ? startOverflow : Math.max(0, endOverflow);
  if (shift === 0) {
    return undefined;
  }
  const behavior = prefersReducedMotion(view) ? "instant" : "smooth";
  if (isHorizontal) {
    const requestedOffset = container.scrollLeft + shift;
    container.scrollTo({ left: requestedOffset, behavior });
    // A glide reaches its offset over later frames; the write answers where it began.
    return { caller, axis, requestedOffset, appliedOffset: container.scrollLeft };
  }
  const requestedOffset = container.scrollTop + shift;
  container.scrollTo({ top: requestedOffset, behavior });
  return { caller, axis, requestedOffset, appliedOffset: container.scrollTop };
}

/**
 * Whether a caller's write is a person's one ask, which nothing repeats, rather than a write the
 * frame makes again as the log or the box moves.
 */
function isAskedOnce(caller: ScrollCaller): boolean {
  switch (caller) {
    case "jump-to-tail":
    case "jump-to-head":
    case "find-match":
    case "message-anchor":
    case "window-opening":
    case "row-reveal":
    case "settings-control-landing":
    case "pane-reveal":
    case "gone-session-control":
      return true;
    case "follow-tail":
    case "follow-arriving-text":
    case "hold-reading-position":
    case "prune-compensation":
    case "measurement-compensation":
    case "reorder-edge-scroll":
      return false;
  }
}

/** Whether a caller's write keeps a following reader on the tail, which a follow hold drops. */
function isFollowWrite(caller: ScrollCaller): boolean {
  switch (caller) {
    case "follow-tail":
    case "follow-arriving-text":
      return true;
    case "jump-to-tail":
    case "jump-to-head":
    case "hold-reading-position":
    case "find-match":
    case "message-anchor":
    case "prune-compensation":
    case "measurement-compensation":
    case "window-opening":
    case "row-reveal":
    case "settings-control-landing":
    case "pane-reveal":
    case "gone-session-control":
    case "reorder-edge-scroll":
      return false;
  }
}

function clampToContent(targetScrollTop: number, maximumScrollTop: number): number {
  if (!Number.isFinite(targetScrollTop)) {
    // Fail closed: the platform silently turns `NaN` into zero, which would teleport the reader
    // to the top of the log.
    return 0;
  }
  return Math.min(Math.max(0, targetScrollTop), maximumScrollTop);
}
