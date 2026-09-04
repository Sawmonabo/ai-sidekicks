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
//     which is what lets `scroll-chokepoint.ts`'s "no hit test per scroll event while
//     following" hold without a special case for the anchor.
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
import { LedgerWindow, type PruneDeferralReason, type PruneOutcome } from "./window-cap.js";

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
  /**
   * The conditions the last reconcile folded in, kept so a deferred prune can be
   * re-asked with them.
   *
   * The surrounding surface reports these on a render, and the three of them are
   * exactly what a re-ask must NOT invent: re-running the prune against a row set
   * this frame made up would apply the cap to a window nobody is showing.
   */
  #lastConditions: LedgerViewportConditions | undefined;
  #publishFrame: ScheduledHandle | undefined;
  #tailGlidePending = false;
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
    this.#lastConditions = conditions;
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
      this.#holdReadingPositionAfterReconcile();
    }
    this.#publish();
  }

  /**
   * Hold the position across a reconcile — the tail arm ARMED rather than performed.
   *
   * The anchor arm runs here as it always has: its index lookup is deliberately in
   * the pre-render offset space, which is the space the anchored row's offset was
   * measured in.
   *
   * The FOLLOWING arm cannot be, and that is the defect this split closes. The rows
   * this reconcile took have not rendered yet, so the sizer still carries the
   * previous total size and `glideToTail()` would read the old `scrollHeight` — it
   * would scroll to the bottom of the log as it was BEFORE the append. Nothing
   * corrects it afterwards: the next render grows the sizer and nothing glides again,
   * because the container did not resize and no further row arrived. The reader is
   * left short of the new entry with the state still reporting `following`. So the
   * glide is armed here and performed by `commitPendingTailGlide`, which the React
   * binding calls in a layout effect that runs AFTER the virtualizer has written the
   * new height.
   */
  #holdReadingPositionAfterReconcile(): void {
    if (this.anchor.state.mode === "following") {
      this.#tailGlidePending = true;
      return;
    }
    this.holdReadingPosition();
  }

  /**
   * Perform the tail glide a reconcile armed, now that the new height is committed.
   *
   * Re-checks the reading mode rather than trusting the arming: a reader who scrolled
   * away between the reconcile and this commit is no longer following, and dragging
   * them to the tail is the one thing the anchor exists to prevent. The flag is
   * cleared either way, so a stale arming never fires against a later render.
   *
   * Idempotent and cheap when nothing is armed, because the binding calls it after
   * every render rather than only after the ones that appended.
   */
  public commitPendingTailGlide(): void {
    if (!this.#tailGlidePending || this.#disposed) {
      return;
    }
    this.#tailGlidePending = false;
    if (this.anchor.state.mode !== "following") {
      return;
    }
    this.scroll.glideToTail("follow-tail");
  }

  /**
   * Re-ask for a prune the window refused, now that the refusal's condition is
   * gone.
   *
   * WHY A SECOND ENTRY POINT AND NOT A WIDER RECONCILE. `reconcile` is driven by
   * the three conditions the surrounding surface reports — the row set, the turn
   * activity, the reveal drain — and three of the six refusals below are conditions
   * NONE of those three carry: a reader above the tail, a pin, and a programmatic
   * write in flight are facts about this controller. A window left over its cap by
   * one of them therefore stayed over cap until the log happened to change, which on
   * an idle session is never — the reader came back to the tail and the rows the cap
   * had already refused to take stayed in memory indefinitely.
   *
   * Idempotent and cheap when nothing is owed: a window whose last prune applied,
   * or was refused for a reason still true, does no work at all — which is what lets
   * the binding call it on a reading transition without checking anything first.
   */
  public retryDeferredPrune(): void {
    const conditions = this.#lastConditions;
    const deferredBecause = this.#lastPrune?.deferredBecause;
    if (this.#disposed || conditions === undefined || deferredBecause === undefined) {
      return;
    }
    if (!this.#deferralHasCleared(deferredBecause)) {
      return;
    }
    this.reconcile(conditions);
  }

  /**
   * Whether the condition that refused the last prune is gone.
   *
   * TOTAL over `PRUNE_DEFERRAL_REASONS`, so a reason `window-cap.ts` registers is a
   * compile error here until it is classified — which is the point: the failure this
   * method exists to prevent is a refusal nobody re-asks about, and a new refusal
   * that silently fell through to "never retry" would be exactly that failure again.
   *
   * THE THREE ARMS THAT ANSWER `false` ARE NOT UNOBSERVABLE, THEY ARE ALREADY
   * OBSERVED. `under-cap` is not a refusal to retry at all — the window is within
   * its cap and there is nothing owed. `active-turn` and `reveal-drain` are read
   * straight off `LedgerViewportConditions`, so the surface that reports them
   * re-runs `reconcile` the moment either changes; retrying them here would be a
   * second reader of one fact, racing the first.
   */
  #deferralHasCleared(deferredBecause: PruneDeferralReason): boolean {
    switch (deferredBecause) {
      case "scroll-write":
        return !this.scroll.vetoesPrune();
      case "pinned-history":
        return this.anchor.state.pinnedRootCursor === undefined;
      case "reading-floor":
        return this.#readingFloorRowKey() === undefined;
      case "under-cap":
      case "active-turn":
      case "reveal-drain":
        return false;
    }
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
   * Called from `reconcile`'s own arm only where no prune compensation ran: its index
   * lookup reads a virtualizer still in the PRE-prune offset space until React
   * re-renders, so after a prune it would name the wrong row. That arm defers the
   * FOLLOWING case to `commitPendingTailGlide` — see
   * `#holdReadingPositionAfterReconcile`. Called directly, as the overflow pass does,
   * both arms run now: a container that has already resized carries a current
   * `scrollHeight`, so there is nothing to wait for.
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
    this.#tailGlidePending = false;
    // The retry's hold on the last row set goes with the subscriptions: a disposed
    // controller that kept it would hold a whole window's identity list alive for
    // as long as anything still referenced the corpse.
    this.#lastConditions = undefined;
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
   * The row the prune may not walk past, or `undefined` while following — where
   * the tail IS the position and the frame glides back to it, so the window is
   * free to take every row the cap allows.
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
    const currentScrollTopPx = this.scroll.geometry?.scrollTop;
    if (prunedHeightPx <= 0 || currentScrollTopPx === undefined) {
      return false;
    }
    return (
      this.scroll.glideTo("prune-compensation", currentScrollTopPx - prunedHeightPx) !== undefined
    );
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
