// Holds the transcript frame's four objects together (scroll chokepoint, reading anchor,
// measurement table, window cap) and decides when each is asked and what the tree is told.
//
// The library owns measurements, offsets and the total size; `virtualizer-options.ts` owns its
// reach to the outside world. The anchor is captured from the virtualizer, never the DOM, so
// holding a reading position costs no element read. The snapshot vocabulary, prune cycle,
// publication, deferred holds, head insertion and anchor capture live in `viewport-*.ts`.

import { type Clock } from "#renderer/lib/clock.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { ReadingAnchor } from "./reading-anchor.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { ViewportAnchorCapture } from "./anchor-capture.js";
import { ViewportDeferredHold } from "./deferred-hold.js";
import { HeadInsertion } from "./head-insertion.js";
import { ViewportPruneCycle } from "./prune-cycle.js";
import { ViewportPublication } from "./publication.js";
import {
  shouldCompensateForInsertion,
  countAppendedAfter,
  type ViewportConditions,
  type ViewportRow,
  type ViewportSnapshot,
} from "./snapshot.js";
import { VirtualizerOptions, type TranscriptRowVirtualizer } from "./virtualizer-options.js";
import { TranscriptWindow } from "./window-cap.js";

/** The clock every timer and frame of the controller is minted through. */
export interface ViewportControllerOptions {
  readonly clock: Clock;
}

/** Wires the scroll, anchor, measurement and window-cap objects into one published snapshot. */
export class ViewportController {
  readonly scroll: ScrollController;
  readonly anchor: ReadingAnchor;
  readonly measurements: RowMeasurementTable;
  readonly rowWindow: TranscriptWindow;
  /** The option object the virtualizer is constructed with. */
  readonly virtualizerOptions: VirtualizerOptions;

  /** The cap, and the re-ask a refusal owes. Constructed over the four above. */
  readonly #pruneCycle: ViewportPruneCycle;
  /** The one place this frame tells a render that something changed. */
  readonly #publication: ViewportPublication;
  /** Which row the reader is on, read without touching an element. */
  readonly #anchorCapture: ViewportAnchorCapture;

  /** The position work a reconcile arms and the binding's layout effect performs. */
  readonly #deferredHold: ViewportDeferredHold;
  /** Whether each incoming set grew at the front, and where it would be cut. */
  readonly #headGrowth = new HeadInsertion();
  readonly #teardown: Unsubscribe[] = [];

  #virtualizer: TranscriptRowVirtualizer | undefined;
  #virtualKeys: readonly string[] = [];
  #rows: readonly ViewportRow[] = [];
  #rowKeys: readonly string[] = [];
  /** The row a link asked to land on, until the committed render that holds it scrolls there. */
  #pendingLandingRowKey: string | undefined;
  #disposed = false;

  public constructor(options: ViewportControllerOptions) {
    this.scroll = new ScrollController({ clock: options.clock });
    this.anchor = new ReadingAnchor();
    this.measurements = new RowMeasurementTable();
    this.rowWindow = new TranscriptWindow();
    this.virtualizerOptions = new VirtualizerOptions({
      scroll: this.scroll,
      measurements: this.measurements,
      virtualKeyAt: (index) => this.#virtualKeys[index],
    });
    this.#pruneCycle = new ViewportPruneCycle({
      window: this.rowWindow,
      measurements: this.measurements,
      anchor: this.anchor,
      scroll: this.scroll,
      clock: options.clock,
    });
    this.#anchorCapture = new ViewportAnchorCapture({
      anchor: this.anchor,
      scroll: this.scroll,
      measurements: this.measurements,
      rowKeys: () => this.#rowKeys,
      virtualizer: () => this.#virtualizer,
    });
    this.#publication = new ViewportPublication({ build: () => this.#buildSnapshot() });
    this.#deferredHold = new ViewportDeferredHold({
      anchor: this.anchor,
      scroll: this.scroll,
      rowKeys: () => this.#rowKeys,
      offsetOfIndex: (index) => this.#anchorCapture.offsetOfIndex(index),
      holdReadingPosition: () => {
        this.holdReadingPosition();
      },
    });
    this.#teardown.push(
      // No publication for a scroll sample: it changes nothing the snapshot carries, and the
      // anchor's capture is silent. A mode change reaches the tree through the anchor's own
      // notification below.
      this.scroll.subscribeToGeometry((geometry) => {
        this.anchor.observeGeometry(geometry);
        this.#anchorCapture.captureFrom(geometry);
      }),
      this.anchor.subscribe(() => {
        this.#publication.publish();
      }),
      this.scroll.observeOverflow(() => {
        // A resize moves the tail without the reader acting, so re-hold before the tree is
        // told.
        this.holdReadingPosition();
        this.#publication.publish();
      }),
    );
  }

  /** Whether this controller has been torn down. Read by the hook's re-mint arm. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** The stable value a render reads. Same reference until something changes. */
  public snapshot(): ViewportSnapshot {
    return this.#publication.current;
  }

  /** Hear every change to the snapshot. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#publication.subscribe(sink);
  }

  /** Drive this scroll container: the chokepoint writes it and the virtualizer reads it. */
  public attach(scrollContainer: HTMLElement): void {
    this.scroll.attach(scrollContainer);
    this.virtualizerOptions.bindScrollContainer(scrollContainer);
  }

  /** Let go of the scroll container, for an unmount or a container about to be replaced. */
  public detach(): void {
    this.scroll.detach();
    this.virtualizerOptions.bindScrollContainer(undefined);
  }

  /**
   * Hands the controller the virtualizer the hook created. The instance must be created in a
   * React hook (`useFlushSync` and `directDomUpdates` exist only on the adapter); the option
   * bodies are methods here so the policy stays in this class.
   */
  public bindVirtualizer(virtualizer: TranscriptRowVirtualizer): void {
    this.#virtualizer = virtualizer;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      shouldCompensateForInsertion(this.anchor.state.mode, item.end, instance.scrollOffset ?? 0);
  }

  /**
   * Folds one render's conditions in: takes the rows, prunes, and holds the reader's position.
   *
   * The cap cycle runs first because it can change the row set, the row set is rebuilt from what
   * the window retained, and the position is held last. The prune compensation is paid here,
   * after the rebuild, because a glide publishes a geometry sample that would otherwise reach
   * the anchor capture against keys the window no longer has.
   */
  public reconcile(conditions: ViewportConditions): void {
    const previousHeadKey = this.#rowKeys[0];
    const previousTailKey = this.#rowKeys[this.#rowKeys.length - 1];
    const scrollTopPx = this.scroll.geometry?.scrollTop ?? 0;
    // Read before the cap runs so the pin is up: a backward page lands over the row cap and the
    // cap prunes oldest-first, so an unpinned pass would take the rows that just arrived.
    const headGrowth = this.#headGrowth.read(conditions.rows);
    if (headGrowth.headRootCursor !== undefined) {
      // Pinning suppresses prune. It clears when the reader reaches the tail again.
      this.anchor.pin(headGrowth.headRootCursor);
    }
    const { prunedHeightPx, readingFloorRowKey } = this.#pruneCycle.run(conditions);
    const retained = this.rowWindow.rows();
    const appendedCount = countAppendedAfter(retained, previousTailKey);
    this.#rows = retained;
    this.#rowKeys = retained.map((row) => row.key);
    this.#virtualKeys = this.measurements.projectKeys(this.#rowKeys).virtualKeys;
    if (appendedCount > 0) {
      this.anchor.noteAppendedRows(appendedCount);
    }
    const compensated =
      readingFloorRowKey !== undefined &&
      this.#pruneCycle.compensateForPrunedHeight(prunedHeightPx);
    if (!compensated) {
      this.#deferredHold.armAfterReconcile({
        headInsertedCount: headGrowth.insertedCount,
        previousHeadKey,
        scrollTopPx,
      });
    }
    this.#publication.publish();
  }

  /**
   * Performs whatever the last reconcile armed, now that the new height is committed. The
   * binding calls it from a layout effect declared after `useVirtualizer`, so the library has
   * already written the container height.
   */
  public commitPendingPositionHold(): void {
    if (this.#disposed) {
      return;
    }
    this.#deferredHold.commit();
  }

  /**
   * Lands the reader on one row, as a link to a message does: reading starts at it, so the cap
   * keeps it and every row after it however far back it sits, and `commitPendingLanding` brings
   * it to the top of the viewport. Call it before the reconcile that brings the row, or that pass
   * may already have pruned it.
   */
  public landOnRow(rowKey: string): void {
    this.anchor.readFrom(rowKey);
    this.#pendingLandingRowKey = rowKey;
  }

  /**
   * Scrolls to the row `landOnRow` named once the window holds it, through the library's own
   * index scroll, which re-aims as the estimated rows above it measure. Called from the same
   * layout effect as the position hold, when the virtualizer counts the rows the window holds.
   * Answers whether it landed, once per landing.
   */
  public commitPendingLanding(): boolean {
    const rowKey = this.#pendingLandingRowKey;
    const virtualizer = this.#virtualizer;
    if (this.#disposed || rowKey === undefined || virtualizer === undefined) {
      return false;
    }
    const index = this.#rowKeys.indexOf(rowKey);
    if (index < 0) {
      return false;
    }
    this.#pendingLandingRowKey = undefined;
    this.virtualizerOptions.scrollFor("message-anchor", () => {
      virtualizer.scrollToIndex(index, { align: "start" });
    });
    return true;
  }

  /**
   * Re-asks for a prune the window refused, once the refusal's condition is gone: one ordinary
   * reconcile over the conditions the refused pass was given. `ViewportPruneCycle.owedConditions`
   * says which refusals need it.
   */
  public retryDeferredPrune(): void {
    if (this.#disposed) {
      return;
    }
    const conditions = this.#pruneCycle.owedConditions();
    if (conditions === undefined) {
      return;
    }
    this.reconcile(conditions);
  }

  /**
   * Declares the display every measurement is taken on. A change drops this table's priors and
   * the library's together; two caches disagreeing about a row's height gives a scrollbar that
   * never settles.
   */
  public observeDisplaySettings(devicePixelRatio: number, rootFontSizePx: number): void {
    if (this.measurements.setDisplaySettings({ devicePixelRatio, rootFontSizePx })) {
      this.#virtualizer?.measure();
      this.#publication.publish();
    }
  }

  /**
   * Puts the reader back where they were if they had left the tail; while following, glides to
   * the tail instead.
   *
   * `reconcile` calls it only where no prune compensation ran: after a prune the virtualizer is
   * still in the pre-prune offset space until React re-renders, so its index lookup would name
   * the wrong row. The following and head-insert cases wait for `commitPendingPositionHold`.
   * Called directly, as the overflow pass does, everything runs now: a container that already
   * resized has a current `scrollHeight`.
   */
  public holdReadingPosition(): void {
    const reading = this.anchor.state;
    if (reading.mode === "following") {
      this.scroll.glideToTail("follow-tail");
      return;
    }
    const anchorPoint = reading.anchorPoint;
    if (anchorPoint === undefined) {
      return;
    }
    const index = this.#rowKeys.indexOf(anchorPoint.rowKey);
    if (index < 0) {
      // The anchored row left the window; guessing a replacement would teleport the
      // transcript, so the offset stays.
      return;
    }
    this.scroll.glideTo(
      "hold-reading-position",
      this.#anchorCapture.offsetOfIndex(index) - anchorPoint.offsetWithinViewportPx,
    );
  }

  /** The tail pill and the keyboard's jump. */
  public jumpToTail(): void {
    this.anchor.resumeFollowing();
    this.scroll.glideToTail("jump-to-tail");
  }

  /** Terminal. Every subscription this controller opened is closed here. */
  public dispose(): void {
    this.#deferredHold.disarm();
    // Drop the retry's hold on the last row set so a disposed controller keeps no window
    // identity list alive.
    this.#pruneCycle.forgetConditions();
    for (const unsubscribe of this.#teardown) {
      unsubscribe();
    }
    this.#teardown.length = 0;
    this.#publication.dispose();
    this.scroll.dispose();
    this.anchor.dispose();
    this.#virtualizer = undefined;
    this.#disposed = true;
  }

  #buildSnapshot(): ViewportSnapshot {
    const { mode, newRowCount, pinnedRootCursor } = this.anchor.state;
    return {
      rows: this.#rows,
      rowKeys: this.#rowKeys,
      keyProjection: this.measurements.projectKeys(this.#rowKeys),
      reading: { mode, newRowCount, pinnedRootCursor },
      lastPrune: this.#pruneCycle.lastOutcome,
    };
  }
}
