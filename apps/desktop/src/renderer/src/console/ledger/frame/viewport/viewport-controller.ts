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
// THE ONE PROPERTY THIS FILE STILL OWNS. **The anchor is captured from the
// virtualizer, never from the DOM.** The row a reader is looking at and its offset
// both fall out of measurements the library already holds, so holding a reading
// position costs no element read at all — which is what lets
// `scroll-chokepoint.ts`'s "no hit test per scroll event while following" hold
// without a special case for the anchor.
//
// WHAT IT NO LONGER DECLARES, in three directions, each stating why its cut is
// there: the value vocabulary a render speaks and the two pure rules over it are
// `viewport-snapshot.ts`'; applying the window cap and deciding whether a refusal
// has lifted are `viewport-prune-cycle.ts`'; holding the published snapshot and
// deciding whether a rebuild is worth a notification are `viewport-publication.ts`'.
// This file holds the objects and the order they are asked in.

import { type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import { ReadingAnchor, RowMeasurementLedger, type LedgerGeometry } from "../measurement/index.js";
import { LedgerScrollController, type LedgerScrollSurface } from "../scroll/index.js";
import { LedgerPruneCycle } from "./viewport-prune-cycle.js";
import { LedgerViewportPublication } from "./viewport-publication.js";
import {
  compensatesForGrowth,
  countAppendedAfter,
  type LedgerViewportConditions,
  type LedgerViewportRow,
  type LedgerViewportSnapshot,
} from "./viewport-snapshot.js";
import { LedgerVirtualizerSeams, type LedgerRowVirtualizer } from "./virtualizer-seams.js";
import { LedgerWindow } from "./window-cap.js";

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

  /** The cap, and the re-ask a refusal owes. Constructed over the four above. */
  readonly #pruneCycle: LedgerPruneCycle;
  /** The one place this frame tells a render that something changed. */
  readonly #publication: LedgerViewportPublication;
  readonly #teardown: Unsubscribe[] = [];

  #virtualizer: LedgerRowVirtualizer | undefined;
  #virtualKeys: readonly string[] = [];
  #rows: readonly LedgerViewportRow[] = [];
  #rowKeys: readonly string[] = [];
  #tailGlidePending = false;
  #disposed = false;

  public constructor(options: LedgerViewportControllerOptions) {
    this.scroll = new LedgerScrollController({ clock: options.clock });
    this.anchor = new ReadingAnchor();
    this.measurements = new RowMeasurementLedger();
    this.window = new LedgerWindow();
    this.seams = new LedgerVirtualizerSeams({
      scroll: this.scroll,
      measurements: this.measurements,
      virtualKeyAt: (index) => this.#virtualKeys[index],
    });
    this.#pruneCycle = new LedgerPruneCycle({
      window: this.window,
      measurements: this.measurements,
      anchor: this.anchor,
      scroll: this.scroll,
    });
    this.#publication = new LedgerViewportPublication({
      clock: options.clock,
      build: () => this.#buildSnapshot(),
    });
    this.#teardown.push(
      // No publication here: a scroll sample changes nothing this snapshot carries.
      // Whatever a scroll DOES change — following became reading, the tail was
      // reached — reaches the tree through the anchor's own notification below.
      this.scroll.subscribeToGeometry((geometry) => {
        this.anchor.observeGeometry(geometry);
        this.#captureAnchorPoint(geometry);
      }),
      this.anchor.subscribe(() => {
        this.#publication.publish();
      }),
      this.scroll.observeOverflow(() => {
        // A resize moves the tail without the reader touching anything, so the
        // position is re-held before the tree is told: a follower re-glides to the
        // bottom the new box put there, and a reader keeps the row they are on.
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
  public snapshot(): LedgerViewportSnapshot {
    return this.#publication.current;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#publication.subscribe(sink);
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
   * Order matters, and the three steps are why this method exists at all. The cap
   * cycle runs first, because it is what can change the row set; the row set is
   * rebuilt from what the window retained; the position is held last, because both
   * of the steps before it can change what is above the fold.
   *
   * The compensation is PAID here rather than inside the cycle that incurred it,
   * and the ordering is the reason: a glide publishes a geometry sample, and a
   * sample taken while this frame still held the pre-prune key list would reach the
   * anchor capture against keys the window no longer has.
   */
  public reconcile(conditions: LedgerViewportConditions): void {
    const previousTailKey = this.#rowKeys[this.#rowKeys.length - 1];
    const { prunedHeightPx, readingFloorRowKey } = this.#pruneCycle.run(conditions);
    const retained = this.window.rows();
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
      this.#holdReadingPositionAfterReconcile();
    }
    this.#publication.publish();
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
   * A second entry point rather than a wider reconcile, because three of the six
   * refusals are facts about this controller that none of the reconcile's own three
   * conditions carry — `viewport-prune-cycle.ts` states which and why, and answers
   * whether the refusal has lifted. This method is the disposal check and the
   * re-drive, and deliberately nothing else: a re-ask is one ordinary reconcile over
   * the conditions the refused pass was given.
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
   * Declare the display every measurement is being taken on.
   *
   * A change drops this ledger's priors AND the library's, in one act: two caches
   * disagreeing about a row's height is a scrollbar that never settles.
   */
  public observeDisplaySettings(devicePixelRatio: number, rootFontSizePx: number): void {
    if (this.measurements.setDisplaySettings({ devicePixelRatio, rootFontSizePx })) {
      this.#virtualizer?.measure();
      this.#publication.publish();
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

  /** Coalesce a burst of library notifications into one snapshot. Test seam too. */
  public schedulePublish(): void {
    this.#publication.scheduleFrame();
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

  #buildSnapshot(): LedgerViewportSnapshot {
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
