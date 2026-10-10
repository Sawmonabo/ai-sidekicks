// Keeping a follower on the tail. The library's end anchor holds the tail as rows measure and
// lands on each appended row; a re-key, a re-measure or a library correction that leaves the
// offset short, and a re-layout of every row, move the tail past its reach, so the follower is
// landed again here. Only the reader leaves the tail, and a reader who does so by their own act
// ends the library's running scroll.

import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollCaller } from "#renderer/lib/scroll/callers.js";
import { SCROLL_TAIL_TOLERANCE_PX } from "#renderer/lib/scroll/geometry/publisher.js";
import { type ReadingAnchor, type ReadingMode } from "./reading-anchor.js";
import { type RowMeasurementTable } from "./row-measurement-table.js";
import { type TranscriptRowVirtualizer, type VirtualizerOptions } from "./virtualizer-options.js";

/** What a `ViewportTailFollow` reads and drives. */
export interface ViewportTailFollowOptions {
  readonly anchor: ReadingAnchor;
  readonly scroll: ScrollController;
  readonly measurements: RowMeasurementTable;
  readonly virtualizerOptions: VirtualizerOptions;
  readonly virtualizer: () => TranscriptRowVirtualizer | undefined;
}

/** Lands a follower on the tail again whenever something other than the reader moved it off. */
export class ViewportTailFollow {
  readonly #anchor: ReadingAnchor;
  readonly #scroll: ScrollController;
  readonly #measurements: RowMeasurementTable;
  readonly #virtualizerOptions: VirtualizerOptions;
  readonly #virtualizer: () => TranscriptRowVirtualizer | undefined;
  /** Whether the reading state last heard from the anchor was following; it starts there. */
  #isFollowingTail = true;
  /** Whether a publication of the estimates is queued behind the current batch of measurements. */
  #isEstimatePublicationQueued = false;
  /** Whether a landing on the tail is queued behind the write that moved a follower off it. */
  #isTailLandingQueued = false;

  public constructor(options: ViewportTailFollowOptions) {
    this.#anchor = options.anchor;
    this.#scroll = options.scroll;
    this.#measurements = options.measurements;
    this.#virtualizerOptions = options.virtualizerOptions;
    this.#virtualizer = options.virtualizer;
  }

  /** The library's own landing on the last row, which re-aims as the rows near it measure. */
  public scrollToTail(caller: ScrollCaller): void {
    const virtualizer = this.#virtualizer();
    if (virtualizer === undefined) {
      return;
    }
    this.#virtualizerOptions.scrollFor(caller, () => {
      virtualizer.scrollToEnd();
    });
  }

  /**
   * Lands a follower the transcript or the library moved off the tail back on it, once, after the
   * write that moved it returns: only the reader leaves the tail, so a re-key, a re-measure or a
   * library correction that left the offset short is undone rather than read as leaving.
   */
  public queueTailLanding(): void {
    if (this.#isTailLandingQueued) {
      return;
    }
    this.#isTailLandingQueued = true;
    queueMicrotask(() => {
      this.#isTailLandingQueued = false;
      if (this.#anchor.state.mode === "following" && this.#scroll.geometry?.isAtTail === false) {
        this.scrollToTail("follow-tail");
      }
    });
  }

  /**
   * Publishes the estimates once after the batch of measurements a follower's rows just made,
   * and re-lays every row out if one moved, so rows above the screen take what the measured rows
   * say. The library's cache is cleared whole, and `estimateSize` hands each measured row's
   * remembered height back to it. The clear moves the tail without moving the offset, and the
   * library re-anchors only a reader already near the end, so the follower is landed on the tail
   * again. A reader who reads keeps the estimates the rows were laid out at.
   */
  public queueEstimatePublication(): void {
    if (this.#isEstimatePublicationQueued) {
      return;
    }
    this.#isEstimatePublicationQueued = true;
    // One microtask after the observer's callback: every row it reported has been accepted.
    queueMicrotask(() => {
      this.#isEstimatePublicationQueued = false;
      if (this.#anchor.state.mode !== "following") {
        return;
      }
      if (this.#measurements.publishEstimates()) {
        this.#virtualizer()?.measure();
        this.scrollToTail("follow-tail");
      }
    });
  }

  /**
   * Retires the library's running scroll when the reader stops following by their own act (a
   * scroll toward the head, a page of history, a link's landing) rather than inside a write this
   * frame made. A tail landing re-aims every frame the last row grows, and nothing in the library
   * cancels it on a gesture, so it would pull the reader back for up to five seconds.
   */
  public noteReadingMode(mode: ReadingMode): void {
    const wasFollowing = this.#isFollowingTail;
    this.#isFollowingTail = mode === "following";
    const virtualizer = this.#virtualizer();
    // `vetoesPrune` answers whether a programmatic glide is in flight: one that moved the reader
    // off the tail is a jump, whose own scroll replaced the library's.
    if (
      !wasFollowing ||
      this.#isFollowingTail ||
      virtualizer === undefined ||
      this.#scroll.vetoesPrune()
    ) {
      return;
    }
    this.#virtualizerOptions.retireLibraryScroll(virtualizer);
  }

  /**
   * The tail's offset over the rows as the library lays them out, while a follower's box stands
   * above it: on opening, and as rows append, before the box has scrolled there. Read from the
   * layout rather than the box, whose height lags the rows the render about to commit draws.
   */
  public unreachedTailPx(): number | undefined {
    const geometry = this.#scroll.geometry;
    const virtualizer = this.#virtualizer();
    if (
      this.#anchor.state.mode !== "following" ||
      geometry === undefined ||
      virtualizer === undefined
    ) {
      return undefined;
    }
    const tailPx = Math.max(0, virtualizer.getTotalSize() - geometry.viewportHeight);
    return geometry.scrollTop < tailPx - SCROLL_TAIL_TOLERANCE_PX ? tailPx : undefined;
  }
}
