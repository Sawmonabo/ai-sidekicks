// Holds the transcript frame's objects together (scroll chokepoint, reading anchor, measurement
// table, window cap, selection tracker) and decides when each is asked and what the tree is told.
//
// The library owns measurements, offsets and the total size, and a follower's position: its end
// anchor holds the tail as rows measure and it lands on each appended row; what moves the tail
// past its reach lands the follower again through `tail-follow.ts`. `virtualizer-options.ts` owns its reach to the outside world. The anchor is captured from the
// virtualizer, never the DOM, so holding a reading position costs no element read. The snapshot
// vocabulary, prune cycle, publication, deferred hold, anchor capture, landing, the history line,
// the tail follow and the reader's input on the box each have a module beside this one.
import { type Clock } from "#renderer/lib/clock.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { type RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { type RowHeightKind } from "../rows/height-kind.js";
import { ReadingAnchor } from "./reading-anchor.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import {
  SCROLL_GEOMETRY_EPSILON_PX,
  type ScrollGeometry,
} from "#renderer/lib/scroll/geometry/sample.js";
import { ViewportAnchorCapture } from "./anchor-capture.js";
import { ViewportDeferredHold } from "./deferred-hold.js";
import { ViewportDrawnBand } from "./drawn-band.js";
import { ViewportHistoryLine } from "./history-line.js";
import { ViewportLanding } from "./landing.js";
import { ViewportPruneCycle } from "./prune-cycle.js";
import { ViewportPublication } from "./publication.js";
import { ViewportReaderInput } from "./reader-input.js";
import { ViewportSelectionTracker } from "./selection/tracker.js";
import {
  shouldCompensateForInsertion,
  countAppendedAfter,
  countInsertedBefore,
  type ViewportConditions,
  type ViewportRow,
  type ViewportSnapshot,
} from "./snapshot.js";
import { ViewportTailFollow } from "./tail-follow.js";
import { VirtualizerOptions, type TranscriptRowVirtualizer } from "./virtualizer-options.js";
import { TranscriptWindow, type WindowSide } from "./window-cap.js";

/**
 * How reading back toward a linked message the log lacks stands: still reading back, or ended at
 * the start of history or a failed read without it.
 */
export type MessageReadBack = "reading-back" | "not-in-history";

/**
 * The clock every timer and frame of the controller is minted through, where heights live, and
 * how a row's kind and body length are told.
 */
export interface ViewportControllerOptions {
  readonly clock: Clock;
  /** The session's record of its row heights; a controller given none keeps its own. */
  readonly rememberedRowHeights?: RememberedRowHeights | undefined;
  /** The height kind the feed draws a row key as; see `RowMeasurementTableOptions`. */
  readonly heightKindOf?: ((rowKey: string) => RowHeightKind) | undefined;
  /** The UTF-8 byte length of a row key's body; see `RowMeasurementTableOptions`. */
  readonly bodyLengthOf?: ((rowKey: string) => number | undefined) | undefined;
  /**
   * Asks the history reader for the stretch past one edge of the log, once the reader's gesture
   * reaches an edge the window already holds; answers whether the daemon has more there to read,
   * so a gesture at an edge with nothing past it keeps its stretch for the other edge. A frame
   * given none reads nothing past the log.
   */
  readonly readBeyondLogEdge?: ((side: WindowSide) => boolean) | undefined;
  /**
   * Whether a row the feed lists draws whole if mounted now, which a landing waits on for every
   * row it will show. A frame given none lands at once.
   */
  readonly isRowPrepared?: ((rowKey: string) => boolean) | undefined;
  /** Whether the feed holds a row out of the list until it draws whole; none when omitted. */
  readonly isRowHeldOut?: ((rowKey: string) => boolean) | undefined;
  /**
   * Whether the feed holds a row out right after the listed row `rowKey`, or before the first
   * listed row for `undefined`, which is where it joins the list.
   */
  readonly holdsRowAfter?: ((rowKey: string | undefined) => boolean) | undefined;
  /** Hear each time any row's work lands, so a waiting landing asks again. */
  readonly subscribeToRowWork?: ((listener: () => void) => Unsubscribe) | undefined;
}

/** Wires the scroll, anchor, measurement and window-cap objects into one published snapshot. */
export class ViewportController {
  readonly scroll: ScrollController;
  readonly anchor: ReadingAnchor;
  readonly measurements: RowMeasurementTable;
  readonly rowWindow: TranscriptWindow;
  /** The option object the virtualizer is constructed with. */
  readonly virtualizerOptions: VirtualizerOptions;
  /** The reader's selection in this viewport, whose end rows the anchor holds. */
  readonly selection: ViewportSelectionTracker;
  /** A landing on one row, from the ask until the render that holds the row scrolls there. */
  readonly landing: ViewportLanding;
  /** The history line above the first row, which the list starts below. */
  readonly historyLine: ViewportHistoryLine;

  /** The window's passes, and the re-ask a refusal owes. Constructed over the four above. */
  readonly #pruneCycle: ViewportPruneCycle;
  /** The one place this frame tells a render that something changed. */
  readonly #publication: ViewportPublication;
  /** Which row the reader is on, read without touching an element. */
  readonly #anchorCapture: ViewportAnchorCapture;

  /** The position work a reconcile arms and the binding's layout effect performs. */
  readonly #deferredHold: ViewportDeferredHold;
  /** The reader's keys, wheel, touch and presses on the box. */
  readonly #readerInput: ViewportReaderInput;
  /** How far beyond the box the rows are drawn, narrowed by each land. */
  readonly #drawnBand: ViewportDrawnBand;
  /** A follower landed on the tail again when something other than the reader moved it off. */
  readonly #tailFollow: ViewportTailFollow;
  readonly #teardown: Unsubscribe[] = [];

  #virtualizer: TranscriptRowVirtualizer | undefined;
  /** The box the chokepoint holds, which a landing focuses. */
  #scrollContainer: HTMLElement | undefined;
  /** Whether following ended for a linked message still being read back. */
  #isReadingBackToMessage = false;
  #virtualKeys: readonly string[] = [];
  #rows: readonly ViewportRow[] = [];
  #rowKeys: readonly string[] = [];
  /** Each row key's index in `#rowKeys`, built on the first lookup after the keys change. */
  #rowIndexByKey: ReadonlyMap<string, number> | undefined;
  /** The last row of the log the last pass was handed, which appended rows are counted after. */
  #logTailKey: string | undefined;
  /** Whether a pass is running, so a sample its own write publishes cannot start another. */
  #isPassRunning = false;
  /** The held set the drawn rows were last extended by, so a change redraws them once. */
  #drawnHeldRowKeys: readonly string[] | undefined;
  #disposed = false;

  public constructor(options: ViewportControllerOptions) {
    this.scroll = new ScrollController({ clock: options.clock });
    this.historyLine = new ViewportHistoryLine({
      scroll: this.scroll,
      publish: () => {
        this.#publication.publish();
      },
    });
    this.anchor = new ReadingAnchor();
    this.measurements = new RowMeasurementTable({
      rememberedHeights: options.rememberedRowHeights,
      heightKindOf: options.heightKindOf,
      bodyLengthOf: options.bodyLengthOf,
      onHeightAccepted: () => {
        this.#tailFollow.queueEstimatePublication();
      },
    });
    this.rowWindow = new TranscriptWindow();
    this.virtualizerOptions = new VirtualizerOptions({
      scroll: this.scroll,
      measurements: this.measurements,
      virtualKeyAt: (index) => this.#virtualKeys[index],
      isFollowing: () => this.anchor.state.mode === "following",
      heldRowIndexes: () => this.#heldRowIndexes(),
      virtualizer: () => this.#virtualizer,
      landingTargetPx: () => this.#landingTargetPx(),
      drawnBandScreenHeights: () => this.#drawnBand.screenHeights,
    });
    this.#tailFollow = new ViewportTailFollow({
      anchor: this.anchor,
      scroll: this.scroll,
      measurements: this.measurements,
      virtualizerOptions: this.virtualizerOptions,
      virtualizer: () => this.#virtualizer,
    });
    this.selection = new ViewportSelectionTracker({
      holdSelectedRows: (rowKeys) => {
        this.#holdSelectedRows(rowKeys);
      },
      logPositionOf: (rowKey) => this.rowWindow.logPositionOf(rowKey),
      logEdgeRowKey: (side) =>
        side === "head" ? this.rowWindow.logHeadRowKey : this.rowWindow.logTailRowKey,
      drawRow: (rowKey) => {
        this.landing.landOnRow(rowKey, "row-reveal");
      },
    });
    this.#pruneCycle = new ViewportPruneCycle({
      window: this.rowWindow,
      measurements: this.measurements,
      anchor: this.anchor,
      scroll: this.scroll,
      clock: options.clock,
      virtualizer: () => this.#virtualizer,
      publishedRowKeys: () => this.#rowKeys,
      publishedIndexOf: (rowKey) => this.#indexOfRowKey(rowKey),
      readBeyondLogEdge: options.readBeyondLogEdge,
    });
    this.#anchorCapture = new ViewportAnchorCapture({
      anchor: this.anchor,
      scroll: this.scroll,
      measurements: this.measurements,
      rowKeys: () => this.#rowKeys,
      virtualizer: () => this.#virtualizer,
      headHeightPx: () => this.historyLine.heightPx,
    });
    this.landing = new ViewportLanding({
      anchor: this.anchor,
      virtualizerOptions: this.virtualizerOptions,
      virtualizer: () => this.#virtualizer,
      indexOfRowKey: (rowKey) => this.#indexOfRowKey(rowKey),
      runOwnPass: () => {
        const conditions = this.#pruneCycle.lastConditions;
        return conditions === undefined ? undefined : this.#runPass(conditions, OWN_PASS);
      },
      focusLog: () => {
        this.#scrollContainer?.focus();
      },
      logRows: () => this.#pruneCycle.lastConditions?.rows ?? [],
      logPositionOf: (rowKey) => this.rowWindow.logPositionOf(rowKey),
      rowHeightPx: (rowKey) => this.measurements.heightOf(rowKey),
      viewportHeightPx: () => this.scroll.geometry?.viewportHeight ?? 0,
      isRowPrepared: options.isRowPrepared ?? ALWAYS_PREPARED,
      isRowHeldOut: options.isRowHeldOut ?? NEVER_HELD_OUT,
      holdsRowAfter: options.holdsRowAfter ?? NEVER_HELD_OUT,
      subscribeToRowWork: options.subscribeToRowWork ?? NO_ROW_WORK,
      onLanding: () => {
        this.#drawnBand.narrow();
      },
    });
    this.#drawnBand = new ViewportDrawnBand({
      clock: options.clock,
      isLanding: () => this.#isLanding(),
      redraw: () => {
        this.virtualizerOptions.redrawBand();
      },
      publish: () => {
        this.#publication.publish();
      },
    });
    this.#publication = new ViewportPublication({ build: () => this.#buildSnapshot() });
    this.#deferredHold = new ViewportDeferredHold({
      scroll: this.scroll,
      rowKeys: () => this.#rowKeys,
      offsetOfIndex: (index) => this.#anchorCapture.offsetOfIndex(index),
      holdReadingPosition: (controlDisplacementPx) => {
        this.holdReadingPosition(controlDisplacementPx);
      },
    });
    this.#readerInput = new ViewportReaderInput({
      noteReaderInput: (inputAtMs, towardSide) => {
        this.anchor.noteReaderInput(inputAtMs);
        this.#drawnBand.widenFully(towardSide);
      },
      notePointerDown: (isDown) => {
        this.anchor.notePointerDown(isDown);
        if (isDown) {
          this.#drawnBand.widenFully();
        }
      },
      selectWholeLog: () => {
        this.selection.selectWholeLog();
      },
      jumpToHead: () => {
        this.#jumpToHead();
      },
      jumpToTail: () => {
        this.jumpToTail();
      },
      reviewPullAt: (side, inputAtMs) => {
        this.#reviewPullAt(side, inputAtMs);
      },
    });
    this.#teardown.push(
      // No publication for a scroll sample: it changes nothing the snapshot carries, and the
      // anchor's capture is silent. A mode change reaches the tree through the anchor's own
      // notification below.
      this.scroll.subscribeToGeometry((geometry) => {
        // Until a link's landing commits, the reading position is the landing's. The rows it
        // brings are not laid out yet, so a sample can read as the tail and resume following,
        // or capture another row and move the floor that keeps the landing's row.
        if (this.landing.isPending) {
          return;
        }
        this.anchor.observeGeometry(geometry);
        if (this.anchor.state.mode === "following" && !geometry.isAtTail) {
          this.#tailFollow.queueTailLanding();
        }
        this.#anchorCapture.captureFrom(geometry);
        // Before the pass, so a land the pass makes narrows the band this sample widened.
        this.#drawnBand.observeGeometry(geometry);
        this.#reviewWindowAfter(geometry);
        this.#drawnBand.review();
      }),
      this.anchor.subscribe((state) => {
        this.#tailFollow.noteReadingMode(state.mode);
        const heldRowKeys = this.anchor.heldRowKeys();
        const hadHeldRowKeys = this.#drawnHeldRowKeys;
        this.#drawnHeldRowKeys = heldRowKeys;
        if (hadHeldRowKeys !== undefined && hadHeldRowKeys !== heldRowKeys) {
          this.virtualizerOptions.redrawBand();
          // A cut that stopped short of a row no longer held is owed now, not at the next scroll.
          this.retryDeferredPrune();
        }
        this.#publication.publish();
      }),
      this.scroll.observeOverflow(() => {
        // A resize moves the tail without the reader acting, so the position is re-held before
        // the tree is told. The library re-anchors a follower when a row or the row set changes,
        // never when only the box does.
        if (this.anchor.state.mode === "following") {
          this.#tailFollow.scrollToTail("follow-tail");
        } else {
          this.holdReadingPosition();
        }
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

  /**
   * Drive this scroll container: the chokepoint writes it, the virtualizer reads it, and Home and
   * End pressed on it jump to the first and last row.
   */
  public attach(scrollContainer: HTMLElement): void {
    if (this.#disposed) {
      return;
    }
    this.detach();
    // What `scrollHeight` would read, from no element: the box holds the history line and the
    // sizer in flow, unpadded, and the library sizes the sizer to its total. Before the library is
    // bound, at the first attach, the box answers once itself.
    this.scroll.attach(scrollContainer, () =>
      this.#virtualizer === undefined
        ? scrollContainer.scrollHeight
        : this.historyLine.heightPx + this.#virtualizer.getTotalSize(),
    );
    this.virtualizerOptions.bindScrollContainer(scrollContainer);
    this.selection.attach(scrollContainer);
    this.#readerInput.attach(scrollContainer);
    this.#scrollContainer = scrollContainer;
  }

  /** Let go of the scroll container, for an unmount or a container about to be replaced. */
  public detach(): void {
    this.scroll.detach();
    this.virtualizerOptions.bindScrollContainer(undefined);
    this.selection.detach();
    this.#readerInput.detach();
    this.#scrollContainer = undefined;
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
   * Folds one render's conditions in: takes the log, runs the window's pass, and holds the
   * reader's position.
   */
  public reconcile(conditions: ViewportConditions): void {
    this.#runPass(conditions, { admitSide: undefined, isRender: true });
    // A new log may hold the rows a waiting landing's screen was missing.
    this.landing.retryWaiting();
  }

  /**
   * Performs the holds a reconcile or a press armed, and a pending landing, now that the new
   * height is committed. The binding calls it from a layout effect declared after `useVirtualizer`,
   * so the library has already written the container height, with the rows that render drew: a
   * press's hold waits for the render whose rows the window has reconciled, since the reconcile
   * runs after it. A land performed here lets the drawn band start widening.
   */
  public commitPendingPositionHold(renderedRows: readonly ViewportRow[]): void {
    if (this.#disposed) {
      return;
    }
    this.#deferredHold.commit(renderedRows === this.#pruneCycle.lastConditions?.rows);
    this.landing.commitPendingLanding();
    this.#drawnBand.review();
  }

  /**
   * Keeps one row where it stands on screen through a press that changes heights in or around it,
   * as a fold's header or chevron does: reading starts at the row, at its offset now, and the
   * hold is performed once the rows the press changes are laid out. A pressed `control` whose row
   * grows above it is moved back by what it moved inside the row, read once then. Does nothing
   * for a row the window does not hold.
   */
  public holdRowInPlace(rowKey: string, control?: HTMLElement): void {
    const rowStartPx = this.rowStartPx(rowKey);
    if (this.#disposed || rowStartPx === undefined) {
      return;
    }
    this.anchor.readFrom(rowKey, rowStartPx - (this.scroll.geometry?.scrollTop ?? 0));
    const controlOffsetPx = control === undefined ? undefined : controlOffsetInRowPx(control);
    this.#deferredHold.armAnchoredHoldAtCommit(() => {
      const movedOffsetPx = control === undefined ? undefined : controlOffsetInRowPx(control);
      return controlOffsetPx === undefined || movedOffsetPx === undefined
        ? 0
        : movedOffsetPx - controlOffsetPx;
    });
  }

  /**
   * Keeps the row nearest the middle of the view where it stands through a change no control on
   * the page was pressed for, as folding every run is. The nearest row `survives` says stays in
   * the list is held, walking out from the middle a row at a time on either side.
   */
  public holdRowNearestMiddle(survives: (rowKey: string) => boolean): void {
    const geometry = this.scroll.geometry;
    const middle = this.#virtualizer?.getVirtualItemForOffset(
      (geometry?.scrollTop ?? 0) + (geometry?.viewportHeight ?? 0) / 2,
    );
    if (middle === undefined) {
      return;
    }
    const rowKeys = this.#rowKeys;
    for (let distance = 0; distance < rowKeys.length; distance += 1) {
      const indexes =
        distance === 0 ? [middle.index] : [middle.index - distance, middle.index + distance];
      for (const index of indexes) {
        const rowKey = rowKeys[index];
        if (rowKey !== undefined && survives(rowKey)) {
          this.holdRowInPlace(rowKey);
          return;
        }
      }
    }
  }

  /**
   * Hears how reading back toward a linked message stands. The link is the reader's own ask, so
   * following ends while its message is read back, and the tail neither pulls the view nor lets go
   * of the stretches arriving above. Read back to the start of history or a failed read without
   * it, the view stays where the reader is rather than moving to the tail.
   */
  public noteMessageReadBack(readBack: MessageReadBack | undefined): void {
    if (readBack === "reading-back") {
      if (!this.#isReadingBackToMessage) {
        this.#isReadingBackToMessage = true;
        this.anchor.stopFollowing();
      }
      return;
    }
    this.#isReadingBackToMessage = false;
  }

  /**
   * Re-asks for a cut the window refused, once the refusal's condition is gone: one ordinary
   * pass over the conditions the refused pass was given. `ViewportPruneCycle.owedConditions`
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
    this.#runPass(conditions, OWN_PASS);
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
   * Puts a reader who left the tail back where they were: the anchored row at the same distance
   * from the top of the viewport, moved on by `controlDisplacementPx` where a pressed control
   * moved inside that row. A follower's position is the library's, so it does nothing.
   *
   * A pass calls it only where no cut compensation ran: after a cut the virtualizer is still in
   * the pre-cut offset space until React re-renders, so its index lookup would name the wrong
   * row. The head-insert case waits for `commitPendingPositionHold`.
   */
  public holdReadingPosition(controlDisplacementPx = 0): void {
    const reading = this.anchor.state;
    const anchorPoint = reading.anchorPoint;
    if (reading.mode === "following" || anchorPoint === undefined) {
      return;
    }
    const index = this.#indexOfRowKey(anchorPoint.rowKey);
    if (index === undefined) {
      // The anchored row left the window; guessing a replacement would teleport the
      // transcript, so the offset stays.
      return;
    }
    this.scroll.glideTo(
      "hold-reading-position",
      this.#anchorCapture.offsetOfIndex(index) -
        anchorPoint.offsetWithinViewportPx +
        controlDisplacementPx,
    );
  }

  /**
   * The tail pill, the palette's jump and End, once the tail's screen draws whole: following
   * resumes, the window takes the tail back if it had let it go, and the library lands on the last
   * row, re-aiming as the rows near it measure and as the rows the pass brought in render.
   */
  public jumpToTail(): void {
    const jump = (): void => {
      this.anchor.resumeFollowing();
      this.#drawnBand.narrow();
      const conditions = this.#pruneCycle.lastConditions;
      if (conditions !== undefined) {
        this.#runPass(conditions, OWN_PASS);
      }
      this.#tailFollow.scrollToTail("jump-to-tail");
    };
    const tailRowKey = this.rowWindow.logTailRowKey;
    if (tailRowKey === undefined) {
      jump();
    } else {
      this.landing.landOncePrepared(tailRowKey, "end", jump);
    }
  }

  /** The keys of the rows the reader's selection runs across, in log order; empty without one. */
  public selectedRowKeys(): readonly string[] {
    const selection = this.selection.selection;
    return selection === undefined
      ? []
      : this.rowWindow.logRowKeysBetween(selection.start.rowKey, selection.end.rowKey);
  }

  /**
   * A row's top edge in the scroller's content, in pixels, read when called; `undefined` when the
   * window does not hold the row.
   */
  public rowStartPx(rowKey: string): number | undefined {
    // Asked on every scroll sample by each long body on screen, so the lookup is a map read.
    const index = this.#indexOfRowKey(rowKey);
    return index === undefined ? undefined : this.#anchorCapture.offsetOfIndex(index);
  }

  /** Terminal. Every subscription this controller opened is closed here. */
  public dispose(): void {
    this.detach();
    this.#deferredHold.disarm();
    this.landing.dispose();
    this.#drawnBand.dispose();
    this.historyLine.dispose();
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

  /**
   * Runs one pass of the window over `conditions` and holds the reader's position, answering
   * whether the rows the viewport holds changed.
   *
   * The pass runs first because it can change the row set, the row set is rebuilt from what the
   * window holds, and the position is held last. The cut compensation is paid here, after the
   * rebuild, because a glide publishes a geometry sample that would otherwise reach the anchor
   * capture against keys the window no longer has. A pass the pass's own write would start is not
   * run. A render's pass always holds the position; a pass the controller runs itself holds it only
   * when the row set changed, because an unchanged set moved no row under the reader.
   */
  #runPass(conditions: ViewportConditions, pass: WindowPass): boolean {
    if (this.#isPassRunning) {
      return false;
    }
    this.#isPassRunning = true;
    try {
      const previousRowKeys = this.#rowKeys;
      const previousVirtualKeys = this.#virtualKeys;
      const scrollTopPx = this.scroll.geometry?.scrollTop ?? 0;
      // Counted on the log, not the window: a row appended past a tail the window let go is still
      // news for the reader's pill.
      const appendedCount = countAppendedAfter(conditions.rows, this.#logTailKey);
      this.#logTailKey = conditions.rows[conditions.rows.length - 1]?.key;
      const { prunedHeightPx, isFollowing } = this.#pruneCycle.run(conditions, pass.admitSide);
      const retained = this.rowWindow.rows();
      const hasRowSetChanged = retained !== this.#rows;
      if (hasRowSetChanged) {
        this.#rows = retained;
        this.#rowKeys = retained.map((row) => row.key);
        this.#rowIndexByKey = undefined;
        this.#virtualKeys = this.measurements.projectKeys(this.#rowKeys).virtualKeys;
        this.virtualizerOptions.rekeyRows();
      }
      if (appendedCount > 0) {
        this.anchor.noteAppendedRows(appendedCount);
      }
      if (
        this.anchor.state.mode === "following" &&
        haveDifferentEnds(previousVirtualKeys, this.#virtualKeys)
      ) {
        // The library lays out again from the lowest row that resized, but from row zero, reading
        // every unmeasured row's estimate, once the row count or an end key changes, so a moved
        // estimate would shift rows above a reader at the next append. While the reader follows,
        // that whole layout runs under the library's end anchor, which keeps the row at the top of
        // the viewport where it was, and the rows above it move out of sight. A reader who reads
        // keeps the estimates the rows were laid out at. A follower's measurements publish too.
        this.measurements.publishEstimates();
      }
      // Rows let go above a reader are paid by arithmetic; rows admitted above them, or a page
      // landing at the head, are held once the render that lays them out commits.
      const compensated =
        !isFollowing && this.#pruneCycle.compensateForPrunedHeight(prunedHeightPx);
      if (!compensated && (pass.isRender || hasRowSetChanged)) {
        this.#deferredHold.armAfterReconcile({
          headInsertedCount: countInsertedBefore(retained, previousRowKeys[0]),
          readRowsInView: () => this.#anchorCapture.rowsInView(scrollTopPx, previousRowKeys),
          hasRowSetChanged,
        });
        if (this.#deferredHold.isHeadHoldArmed) {
          this.#drawnBand.narrow();
        }
      }
      this.#publication.publish();
      return hasRowSetChanged;
    } finally {
      this.#isPassRunning = false;
    }
  }

  /**
   * Asks the window for the pass a reader's scroll sample owes it, else for a refused cut whose
   * refusal the sample lifted: the first sample with a height, a held row released.
   */
  #reviewWindowAfter(geometry: ScrollGeometry): void {
    const request = this.#pruneCycle.passOwedBy(geometry);
    const conditions = this.#pruneCycle.lastConditions;
    if (request !== undefined && conditions !== undefined) {
      this.#runPass(conditions, { admitSide: request.admitSide, isRender: false });
      return;
    }
    this.retryDeferredPrune();
  }

  /**
   * Asks the window for the pass a pull past one end owes, when the box already stands at that
   * end: there it cannot scroll, so the pull publishes no sample for `#reviewWindowAfter`.
   */
  #reviewPullAt(side: WindowSide, inputAtMs: number): void {
    const geometry = this.scroll.geometry;
    if (this.landing.isPending || geometry === undefined) {
      return;
    }
    const distanceFromEndPx = side === "head" ? geometry.scrollTop : geometry.distanceFromTailPx;
    if (distanceFromEndPx >= SCROLL_GEOMETRY_EPSILON_PX) {
      return;
    }
    const request = this.#pruneCycle.passOwedByPullAt(side, inputAtMs);
    const conditions = this.#pruneCycle.lastConditions;
    if (request !== undefined && conditions !== undefined) {
      this.#runPass(conditions, { admitSide: request.admitSide, isRender: false });
    }
  }

  /** A published key's index, the first for a repeated key, or `undefined` when not held. */
  #indexOfRowKey(rowKey: string): number | undefined {
    // Reversed so a repeated key keeps its first row, as an index search would.
    this.#rowIndexByKey ??= new Map(
      this.#rowKeys.map((key, index) => [key, index] as const).reverse(),
    );
    return this.#rowIndexByKey.get(rowKey);
  }

  /**
   * Holds exactly these rows for the reader's selection, the rows it starts and ends in, and
   * releases every other: the window keeps a held row while it sits within its let-go distance,
   * and the virtualizer draws it there, so the browser's selection stays anchored.
   */
  #holdSelectedRows(rowKeys: readonly string[]): void {
    for (const heldRowKey of this.anchor.heldRowKeys()) {
      if (!rowKeys.includes(heldRowKey)) {
        this.anchor.release(heldRowKey);
      }
    }
    for (const rowKey of rowKeys) {
      this.anchor.hold(rowKey, "selection");
    }
  }

  /** The indexes of the held rows the window keeps. */
  #heldRowIndexes(): readonly number[] {
    return this.anchor.heldRowKeys().flatMap((rowKey) => {
      const index = this.#indexOfRowKey(rowKey);
      return index === undefined ? [] : [index];
    });
  }

  /** Home: the log's first row at the top of the viewport, admitted first if it was let go. */
  #jumpToHead(): void {
    const headRowKey = this.rowWindow.logHeadRowKey;
    if (headRowKey !== undefined) {
      this.landing.landOnRow(headRowKey, "jump-to-head");
    }
  }

  /**
   * The offset the land on its way ends at: the head hold's, then a row landing's, then the tail
   * for a follower the box does not yet stand at; `undefined` with none on its way.
   */
  #landingTargetPx(): number | undefined {
    return (
      this.#deferredHold.headHoldTargetPx() ??
      this.landing.pendingTargetPx() ??
      this.#tailFollow.unreachedTailPx()
    );
  }

  /** Whether a land is on its way, which the drawn band waits on before it widens. */
  #isLanding(): boolean {
    return (
      this.#deferredHold.isHeadHoldArmed ||
      this.landing.isPending ||
      (this.anchor.state.mode === "following" &&
        (this.scroll.geometry === undefined || this.#tailFollow.unreachedTailPx() !== undefined))
    );
  }

  #buildSnapshot(): ViewportSnapshot {
    const { mode, newRowCount } = this.anchor.state;
    return {
      rows: this.#rows,
      rowKeys: this.#rowKeys,
      keyProjection: this.measurements.projectKeys(this.#rowKeys),
      reading: { mode, newRowCount },
      lastPrune: this.#pruneCycle.lastOutcome,
      headHeightPx: this.historyLine.heightPx,
      heldRowKeys: this.anchor.heldRowKeys(),
      drawnBandScreenHeights: this.#drawnBand.screenHeights,
    };
  }
}

/** Whether two key lists differ in length or at either end, which lays the library out anew. */
function haveDifferentEnds(previousKeys: readonly string[], nextKeys: readonly string[]): boolean {
  return (
    previousKeys.length !== nextKeys.length ||
    previousKeys[0] !== nextKeys[0] ||
    previousKeys[previousKeys.length - 1] !== nextKeys[nextKeys.length - 1]
  );
}

/**
 * How far a control sits below the top of the row it is drawn in, in pixels, or `undefined` once
 * the press took it off the page.
 */
function controlOffsetInRowPx(control: HTMLElement): number | undefined {
  const rowElement = control.closest(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`);
  return rowElement === null
    ? undefined
    : control.getBoundingClientRect().top - rowElement.getBoundingClientRect().top;
}

/** What starts one pass of the window: the side a reader's approach admits on, and who asked. */
interface WindowPass {
  readonly admitSide: WindowSide | undefined;
  readonly isRender: boolean;
}

/** What a frame told nothing of its rows' preparation answers: every row draws whole. */
const ALWAYS_PREPARED = (): boolean => true;

/** What a frame told nothing of its rows' preparation holds out: no row. */
const NEVER_HELD_OUT = (): boolean => false;

/** What a frame told nothing of its rows' preparation hears: no work ever lands. */
const NO_ROW_WORK = (): Unsubscribe => () => undefined;

/** A pass the controller runs itself, outside a render, with no side to admit on. */
const OWN_PASS: WindowPass = { admitSide: undefined, isRender: false };
