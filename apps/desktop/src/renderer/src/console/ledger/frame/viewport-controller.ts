// What holds the ledger frame's four objects together, and the hook a view reads it
// through.
//
// The scroll chokepoint, the reading anchor, the measurement ledger, and the window
// cap are each one idea and each testable alone. They are also useless alone: the
// anchor decides where the reader is and only the chokepoint can hold them there;
// the virtualizer knows every row's offset and the anchor is the only thing that
// knows which offset matters. This class is that wiring and nothing else — every
// rule it obeys lives in one of the four, or in the library.
//
// WHAT THE LIBRARY OWNS AND WHAT THIS CLASS OWNS.
// `Spec-023 §Console Libraries` adopts `@tanstack/react-virtual` "under our own
// scroll controller". The library owns the measurements, the offsets, the total
// size, and which indexes are inside the fold; `virtualizer-seams.ts` owns every way
// it reaches the outside world; this class owns when the four objects below are
// asked anything, and what the tree is told afterwards.
//
// TWO PROPERTIES WORTH NAMING:
//
//   • **The anchor is captured from the virtualizer, never from the DOM.** The row a
//     reader is looking at and its offset both fall out of measurements the library
//     already holds, so holding a reading position costs no element read at all —
//     which is what lets `Spec-023 §Console Design (Meridian)` §5.8's "no hit test
//     per scroll event while following" hold without a special case for the anchor.
//   • **A snapshot is a value, recomputed on change.** `useSyncExternalStore`
//     demands a stable reference between changes, and recomputing one per render
//     would tear the tree. Every producer routes through `#publish`, which rebuilds
//     the snapshot once and notifies once.
//
// WHAT IT NO LONGER DECLARES. The value vocabulary a render speaks — the row alias,
// the reading state, the snapshot, the conditions folded into it — and the two pure
// rules over that vocabulary live in `viewport-snapshot.ts`, which states why the
// cut is there. This file holds the objects; that one holds the values.

import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import { type LedgerGeometry } from "./geometry-sample.js";
import { ReadingAnchor } from "./reading-anchor.js";
import { RowMeasurementLedger } from "./row-measurement-ledger.js";
import { LedgerScrollController, type LedgerScrollSurface } from "./scroll-chokepoint.js";
import {
  compensatesForGrowth,
  countAppendedAfter,
  type LedgerViewportConditions,
  type LedgerViewportRow,
  type LedgerViewportSnapshot,
} from "./viewport-snapshot.js";
import { LedgerVirtualizerSeams, type LedgerRowVirtualizer } from "./virtualizer-seams.js";
import { LedgerWindow, type PruneOutcome } from "./window-cap.js";

export interface LedgerViewportControllerOptions {
  readonly clock: ConsoleClock;
}

export class LedgerViewportController {
  readonly scroll: LedgerScrollController;
  readonly anchor: ReadingAnchor;
  readonly measurements: RowMeasurementLedger;
  readonly window: LedgerWindow;
  /** The option object the virtualizer is constructed with. */
  readonly seams: LedgerVirtualizerSeams;

  readonly #clock: ConsoleClock;
  readonly #changeEmitter = new Emitter<void>("ledger viewport snapshot");
  readonly #teardown: Unsubscribe[] = [];

  #virtualizer: LedgerRowVirtualizer | undefined;
  #virtualKeys: readonly string[] = [];
  #rows: readonly LedgerViewportRow[] = [];
  #rowKeys: readonly string[] = [];
  #snapshot: LedgerViewportSnapshot;
  #lastPrune: PruneOutcome | undefined;
  #publishFrame: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: LedgerViewportControllerOptions) {
    this.#clock = options.clock;
    this.scroll = new LedgerScrollController({ clock: options.clock });
    this.anchor = new ReadingAnchor();
    this.measurements = new RowMeasurementLedger();
    this.window = new LedgerWindow();
    this.seams = new LedgerVirtualizerSeams({
      scroll: this.scroll,
      measurements: this.measurements,
      virtualKeyAt: (index) => this.#virtualKeys[index],
    });
    this.#snapshot = this.#buildSnapshot();
    this.#teardown.push(
      // No `#publish` here: a scroll sample changes nothing this snapshot carries.
      // Whatever a scroll DOES change — following became reading, the tail was
      // reached — reaches the tree through the anchor's own notification below.
      this.scroll.subscribeToGeometry((geometry) => {
        this.anchor.observeGeometry(geometry);
        this.#captureAnchorPoint(geometry);
      }),
      this.anchor.subscribe(() => {
        this.#publish();
      }),
      this.scroll.observeOverflow(() => {
        // A resize moves the tail without the reader touching anything, so the
        // position is re-held before the tree is told: a follower re-glides to the
        // bottom the new box put there, and a reader keeps the row they are on.
        this.holdReadingPosition();
        this.#publish();
      }),
    );
  }

  /** Whether this controller has been torn down. Read by the hook's re-mint arm. */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** The stable value a render reads. Same reference until something changes. */
  public snapshot(): LedgerViewportSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changeEmitter.subscribe(sink);
  }

  public attach(surface: LedgerScrollSurface): void {
    this.scroll.attach(surface);
    this.seams.bindSurface(surface);
  }

  public detach(): void {
    this.scroll.detach();
    this.seams.bindSurface(undefined);
  }

  /**
   * Hand the controller the virtualizer the hook minted.
   *
   * The instance is created inside a React hook because `useFlushSync` and
   * `directDomUpdates` are the React adapter's options and exist nowhere else; the
   * POLICY those options run under is this class's, which is why every option body
   * below is a method here rather than a closure in the component.
   */
  public bindVirtualizer(virtualizer: LedgerRowVirtualizer): void {
    this.#virtualizer = virtualizer;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      compensatesForGrowth(this.anchor.state.mode, item.end, instance.scrollOffset ?? 0);
  }

  /**
   * Fold one render's conditions in: take the rows, prune, and hold the reader's
   * position across whatever that changed.
   *
   * Order matters. Ingest first so the window knows about every row; prune second
   * so the cap is applied to the full set; hold the position last, because both of
   * the steps before it can change what is above the fold.
   */
  public reconcile(conditions: LedgerViewportConditions): void {
    const previousTailKey = this.#rowKeys[this.#rowKeys.length - 1];
    const readingFloorRowKey = this.#readingFloorRowKey();
    this.window.ingest(conditions.rows);
    this.#lastPrune = this.window.prune({
      hasActiveTurn: conditions.hasActiveTurn,
      scrollControllerVetoes: this.scroll.vetoesPrune(),
      revealDrainInFlight: conditions.isRevealDraining,
      pinnedRootCursor: this.anchor.state.pinnedRootCursor,
      heldRowKeys: this.anchor.heldRowKeys(),
      readingFloorRowKey,
    });
    // Summed BEFORE the priors are dropped: after the loop below there is nothing
    // left to ask how tall the pruned rows were.
    const prunedHeightPx = this.#lastPrune.prunedKeys.reduce(
      (heightPx, prunedKey) => heightPx + this.measurements.heightOf(prunedKey),
      0,
    );
    for (const prunedKey of this.#lastPrune.prunedKeys) {
      this.measurements.forget(prunedKey);
    }
    const retained = this.window.rows();
    const appendedCount = countAppendedAfter(retained, previousTailKey);
    this.#rows = retained;
    this.#rowKeys = retained.map((row) => row.key);
    this.#virtualKeys = this.measurements.projectKeys(this.#rowKeys).virtualKeys;
    if (appendedCount > 0) {
      this.anchor.noteAppendedRows(appendedCount);
    }
    const compensated =
      readingFloorRowKey !== undefined && this.#compensateForPrunedHeight(prunedHeightPx);
    if (!compensated) {
      this.holdReadingPosition();
    }
    this.#publish();
  }

  /**
   * Declare the display every measurement is being taken on.
   *
   * A change drops this ledger's priors AND the library's, in one act: two caches
   * disagreeing about a row's height is a scrollbar that never settles.
   */
  public observeDisplaySettings(devicePixelRatio: number, rootFontSizePx: number): void {
    if (this.measurements.setDisplaySettings({ devicePixelRatio, rootFontSizePx })) {
      this.#virtualizer?.measure();
      this.#publish();
    }
  }

  /**
   * Put the reader back where they were, if they had left the tail.
   *
   * While following, the tail is the position, so the frame glides there instead —
   * which is the one case where the ledger moves the offset on its own, and it does
   * it only because the reader asked for it by being at the tail.
   *
   * Called from `reconcile` only where no prune compensation ran: its index lookup
   * reads a virtualizer still in the PRE-prune offset space until React re-renders,
   * so after a prune it would name the wrong row.
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
      // The anchored row left the window. Rather than guess at a replacement — which
      // is how a ledger teleports — the offset is left exactly where it is.
      return;
    }
    this.scroll.glideTo(
      "hold-reading-position",
      this.#offsetOfIndex(index) - anchorPoint.offsetWithinViewportPx,
    );
  }

  /** The tail pill and the keyboard's jump. */
  public jumpToTail(): void {
    this.anchor.resumeFollowing();
    this.scroll.glideToTail("jump-to-tail");
  }

  /** Terminal. Every subscription this controller opened is closed here. */
  public dispose(): void {
    for (const unsubscribe of this.#teardown) {
      unsubscribe();
    }
    this.#teardown.length = 0;
    this.#cancelPublishFrame();
    this.scroll.dispose();
    this.anchor.dispose();
    this.#changeEmitter.clear();
    this.#virtualizer = undefined;
    this.#disposed = true;
  }

  /** Coalesce a burst of library notifications into one snapshot. Test seam too. */
  public schedulePublish(): void {
    if (this.#publishFrame !== undefined || this.#disposed) {
      return;
    }
    this.#publishFrame = this.#clock.scheduleFrame(() => {
      this.#publishFrame = undefined;
      this.#publish();
    });
  }

  /**
   * Where a row's top edge sits, from measurements the library already holds.
   *
   * No element is read, so this is affordable on the scroll path — which is the
   * whole reason the anchor is captured from here rather than from a rect.
   */
  #offsetOfIndex(index: number): number {
    const offsetForIndex = this.#virtualizer?.getOffsetForIndex(index, "start");
    if (offsetForIndex !== undefined) {
      return offsetForIndex[0];
    }
    // Before the virtualizer has mounted there are no measurements to read, so the
    // ledger answers from its own priors rather than pretending the offset is zero.
    let offset = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      offset += this.measurements.heightOf(this.#rowKeys[cursor] ?? "");
    }
    return offset;
  }

  /**
   * Which row the reader is looking at, and how far down the viewport it sits.
   *
   * Read from the library's measurements rather than from the DOM: no element is
   * touched, so this is affordable on the scroll path.
   */
  #captureAnchorPoint(geometry: LedgerGeometry): void {
    if (geometry.isAtTail || this.#rowKeys.length === 0) {
      return;
    }
    if (this.scroll.vetoesPrune()) {
      // This sample was published from INSIDE a programmatic glide, so it reports
      // where the ledger just put the reader rather than where the reader went. Two
      // reasons not to anchor to it, and either alone is sufficient: it would discard
      // the very position the glide was performed to preserve, and — because an
      // anchor change notifies the tree, and a render re-runs the virtualizer's
      // layout effects, which can glide again — it closes a loop that does not
      // settle. Only a scroll the READER performed moves the anchor.
      return;
    }
    const topItem = this.#virtualizer?.getVirtualItemForOffset(geometry.scrollTop);
    const index = topItem?.index ?? 0;
    const rowKey = this.#rowKeys[index];
    if (rowKey === undefined) {
      return;
    }
    this.anchor.capture({
      rowKey,
      offsetWithinViewportPx: (topItem?.start ?? this.#offsetOfIndex(index)) - geometry.scrollTop,
    });
  }

  /**
   * The row the prune may not walk past, or `undefined` while following.
   *
   * While following there is no reading position to protect — the tail is the
   * position, and the frame glides back to it — so the window is free to take
   * every row the cap allows.
   */
  #readingFloorRowKey(): string | undefined {
    const reading = this.anchor.state;
    return reading.mode === "following" ? undefined : reading.anchorPoint?.rowKey;
  }

  /**
   * Move the offset up by exactly what prune took from above the reader.
   *
   * Arithmetic rather than a second anchor glide: React has not re-rendered yet, so
   * the virtualizer still answers in the pre-prune offset space. What was dropped is
   * known exactly and the reading floor guarantees every pixel of it sat above the
   * reader, so subtracting the sum leaves their row under the same pixel with no
   * measurement read at all. Returns whether the offset moved, so the caller can
   * fall back to the anchor glide when there was nothing or nowhere to compensate.
   */
  #compensateForPrunedHeight(prunedHeightPx: number): boolean {
    const scrollTop = this.scroll.geometry?.scrollTop;
    if (prunedHeightPx <= 0 || scrollTop === undefined) {
      return false;
    }
    return this.scroll.glideTo("prune-compensation", scrollTop - prunedHeightPx) !== undefined;
  }

  #buildSnapshot(): LedgerViewportSnapshot {
    const { mode, newRowCount, pinnedRootCursor } = this.anchor.state;
    return {
      rows: this.#rows,
      rowKeys: this.#rowKeys,
      keyProjection: this.measurements.projectKeys(this.#rowKeys),
      reading: { mode, newRowCount, pinnedRootCursor },
      lastPrune: this.#lastPrune,
    };
  }

  /**
   * Publish, but only when the published thing actually differs.
   *
   * `useSyncExternalStore` re-renders on every notification, and a render re-runs the
   * virtualizer's layout effects, which can move the offset, which notifies again. A
   * notification that carries no change is therefore not merely wasted work — it is
   * one turn of a loop that does not settle. Every member below is compared the way
   * it is produced: the three arrays and the prune outcome by identity, because each
   * is rebuilt exactly when it changes, and the three reading fields by value.
   */
  #publish(): void {
    const next = this.#buildSnapshot();
    const current = this.#snapshot;
    if (
      next.rows === current.rows &&
      next.rowKeys === current.rowKeys &&
      next.keyProjection === current.keyProjection &&
      next.lastPrune === current.lastPrune &&
      next.reading.mode === current.reading.mode &&
      next.reading.newRowCount === current.reading.newRowCount &&
      next.reading.pinnedRootCursor === current.reading.pinnedRootCursor
    ) {
      return;
    }
    this.#snapshot = next;
    this.#changeEmitter.emit(undefined);
  }

  #cancelPublishFrame(): void {
    if (this.#publishFrame === undefined) {
      return;
    }
    this.#clock.cancel(this.#publishFrame);
    this.#publishFrame = undefined;
  }
}
