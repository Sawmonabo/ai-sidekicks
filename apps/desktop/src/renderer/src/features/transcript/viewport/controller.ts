// Holds the transcript frame's four objects together (scroll chokepoint, reading anchor,
// measurement table, window cap) and decides when each is asked and what the tree is told.
//
// The library owns measurements, offsets and the total size, and a follower's position: its end
// anchor holds the tail as rows measure and it lands on each appended row. `virtualizer-options.ts`
// owns its reach to the outside world. The anchor is captured from the virtualizer, never the DOM,
// so holding a reading position costs no element read. The snapshot vocabulary, prune cycle,
// publication, deferred hold and anchor capture each have a module beside this one.

import { type Clock } from "#renderer/lib/clock.js";
import { type RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { type RowHeightKind } from "../rows/height-kind.js";
import { ReadingAnchor, type ReadingMode } from "./reading-anchor.js";
import { RowMeasurementTable } from "./row-measurement-table.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollCaller } from "#renderer/lib/scroll/callers.js";
import { type ScrollGeometry } from "#renderer/lib/scroll/geometry/sample.js";
import { ViewportAnchorCapture } from "./anchor-capture.js";
import { ViewportDeferredHold } from "./deferred-hold.js";
import { ViewportPruneCycle } from "./prune-cycle.js";
import { ViewportPublication } from "./publication.js";
import {
  shouldCompensateForInsertion,
  countAppendedAfter,
  countInsertedBefore,
  type ViewportConditions,
  type ViewportRow,
  type ViewportSnapshot,
} from "./snapshot.js";
import { VirtualizerOptions, type TranscriptRowVirtualizer } from "./virtualizer-options.js";
import { TranscriptWindow, type WindowSide } from "./window-cap.js";

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
}

/** Wires the scroll, anchor, measurement and window-cap objects into one published snapshot. */
export class ViewportController {
  readonly scroll: ScrollController;
  readonly anchor: ReadingAnchor;
  readonly measurements: RowMeasurementTable;
  readonly rowWindow: TranscriptWindow;
  /** The option object the virtualizer is constructed with. */
  readonly virtualizerOptions: VirtualizerOptions;

  /** The window's passes, and the re-ask a refusal owes. Constructed over the four above. */
  readonly #pruneCycle: ViewportPruneCycle;
  /** The one place this frame tells a render that something changed. */
  readonly #publication: ViewportPublication;
  /** Which row the reader is on, read without touching an element. */
  readonly #anchorCapture: ViewportAnchorCapture;

  /** The position work a reconcile arms and the binding's layout effect performs. */
  readonly #deferredHold: ViewportDeferredHold;
  readonly #teardown: Unsubscribe[] = [];

  #virtualizer: TranscriptRowVirtualizer | undefined;
  /** The box the keyboard's Home and End are heard on, the one the chokepoint holds. */
  #scrollContainer: HTMLElement | undefined;
  /** Whether the reading state last heard from the anchor was following; it starts there. */
  #isFollowingTail = true;
  /** Whether a publication of the estimates is queued behind the current batch of measurements. */
  #isEstimatePublicationQueued = false;
  #virtualKeys: readonly string[] = [];
  #rows: readonly ViewportRow[] = [];
  #rowKeys: readonly string[] = [];
  /** Each row key's index in `#rowKeys`, built on the first lookup after the keys change. */
  #rowIndexByKey: ReadonlyMap<string, number> | undefined;
  /**
   * The row a landing asked for and who asked, until the committed render that holds it scrolls
   * there; no scroll sample moves the reading state meanwhile.
   */
  #pendingLanding: { readonly rowKey: string; readonly caller: RowLandingCaller } | undefined;
  /** The last row of the log the last pass was handed, which appended rows are counted after. */
  #logTailKey: string | undefined;
  /** Whether a pass is running, so a sample its own write publishes cannot start another. */
  #isPassRunning = false;
  #disposed = false;

  /**
   * Home and End pressed on the log itself. A key pressed in a control inside a row, or with a
   * modifier, or already handled, is not the log's; the browser's own jump is prevented because
   * it lands on an estimated end.
   */
  readonly #onScrollContainerKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.target !== event.currentTarget || hasModifier(event)) {
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      this.#jumpToHead();
    } else if (event.key === "End") {
      event.preventDefault();
      this.jumpToTail();
    }
  };

  public constructor(options: ViewportControllerOptions) {
    this.scroll = new ScrollController({ clock: options.clock });
    this.anchor = new ReadingAnchor();
    this.measurements = new RowMeasurementTable({
      rememberedHeights: options.rememberedRowHeights,
      heightKindOf: options.heightKindOf,
      bodyLengthOf: options.bodyLengthOf,
      onHeightAccepted: () => {
        this.#queueEstimatePublication();
      },
    });
    this.rowWindow = new TranscriptWindow();
    this.virtualizerOptions = new VirtualizerOptions({
      scroll: this.scroll,
      measurements: this.measurements,
      virtualKeyAt: (index) => this.#virtualKeys[index],
      isFollowing: () => this.anchor.state.mode === "following",
      virtualizer: () => this.#virtualizer,
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
        // Until a link's landing commits, the reading position is the landing's. The rows it
        // brings are not laid out yet, so a sample can read as the tail and resume following,
        // or capture another row and move the floor that keeps the landing's row.
        if (this.#pendingLanding !== undefined) {
          return;
        }
        this.anchor.observeGeometry(geometry);
        this.#anchorCapture.captureFrom(geometry);
        this.#reviewWindowAfter(geometry);
      }),
      this.anchor.subscribe((state) => {
        this.#noteReadingMode(state.mode);
        this.#publication.publish();
      }),
      this.scroll.observeOverflow(() => {
        // A resize moves the tail without the reader acting, so the position is re-held before
        // the tree is told. The library re-anchors a follower when a row or the row set changes,
        // never when only the box does.
        if (this.anchor.state.mode === "following") {
          this.#scrollToTail("follow-tail");
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
    // What `scrollHeight` would read, from no element: the sizer is the box's one child in flow,
    // unpadded, and the library sizes it to its total. Before the library is bound, at the first
    // attach, the box answers once itself.
    this.scroll.attach(
      scrollContainer,
      () => this.#virtualizer?.getTotalSize() ?? scrollContainer.scrollHeight,
    );
    this.virtualizerOptions.bindScrollContainer(scrollContainer);
    scrollContainer.addEventListener("keydown", this.#onScrollContainerKeyDown);
    this.#scrollContainer = scrollContainer;
  }

  /** Let go of the scroll container, for an unmount or a container about to be replaced. */
  public detach(): void {
    this.scroll.detach();
    this.virtualizerOptions.bindScrollContainer(undefined);
    this.#scrollContainer?.removeEventListener("keydown", this.#onScrollContainerKeyDown);
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
  }

  /**
   * Performs the head hold the last reconcile armed, now that the new height is committed. The
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
   * Lands the reader on one row, as a link to a message, a find step or Home does: reading starts
   * at it, the window centers on it however far from the window it sits, and
   * `commitPendingLanding` brings it into view. A link's row may not be in the log yet; the pass
   * that brings it centers the window then. Until it lands, the landing wins over a return to the
   * tail.
   */
  public landOnRow(rowKey: string, caller: RowLandingCaller): void {
    this.anchor.readFrom(rowKey);
    this.#pendingLanding = { rowKey, caller };
    const conditions = this.#pruneCycle.lastConditions;
    if (conditions === undefined) {
      return;
    }
    // A row the window already held lands now: the virtualizer still counts the same rows. A row
    // the pass brought in lands once the render that holds it commits.
    // A link's landing waits for the binding's layout effect, which also hands the log focus.
    if (!this.#runPass(conditions, OWN_PASS) && caller !== "message-anchor") {
      this.commitPendingLanding();
    }
  }

  /**
   * Scrolls to the row `landOnRow` named once the window holds it, through the library's own
   * index scroll, which re-aims as the estimated rows around it measure: a link's row and Home's
   * at the top of the viewport, a find match in its middle. Called from the same layout effect as
   * the position hold, when the virtualizer counts the rows the window holds. Answers who landed,
   * once per landing, or `undefined`.
   */
  public commitPendingLanding(): RowLandingCaller | undefined {
    const landing = this.#pendingLanding;
    const virtualizer = this.#virtualizer;
    if (this.#disposed || landing === undefined || virtualizer === undefined) {
      return undefined;
    }
    const index = this.#indexOfRowKey(landing.rowKey);
    if (index === undefined) {
      return undefined;
    }
    this.#pendingLanding = undefined;
    this.virtualizerOptions.scrollFor(landing.caller, () => {
      virtualizer.scrollToIndex(index, {
        align: landing.caller === "find-match" ? "center" : "start",
      });
    });
    return landing.caller;
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
   * from the top of the viewport. A follower's position is the library's, so it does nothing.
   *
   * A pass calls it only where no cut compensation ran: after a cut the virtualizer is still in
   * the pre-cut offset space until React re-renders, so its index lookup would name the wrong
   * row. The head-insert case waits for `commitPendingPositionHold`.
   */
  public holdReadingPosition(): void {
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
      this.#anchorCapture.offsetOfIndex(index) - anchorPoint.offsetWithinViewportPx,
    );
  }

  /**
   * The tail pill, the palette's jump and End: following resumes, the window takes the tail back
   * if it had let it go, and the library lands on the last row, re-aiming as the rows near it
   * measure and as the rows the pass brought in render.
   */
  public jumpToTail(): void {
    this.anchor.resumeFollowing();
    const conditions = this.#pruneCycle.lastConditions;
    if (conditions !== undefined) {
      this.#runPass(conditions, OWN_PASS);
    }
    this.#scrollToTail("jump-to-tail");
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
   * Publishes the estimates once after the batch of measurements a follower's rows just made,
   * and re-lays every row out if one moved, so rows above the screen take what the measured rows
   * say while the library's end anchor keeps them out of sight. The library's cache is cleared
   * whole, and `estimateSize` hands each measured row's remembered height back to it. A reader
   * who reads keeps the estimates the rows were laid out at.
   */
  #queueEstimatePublication(): void {
    if (this.#isEstimatePublicationQueued) {
      return;
    }
    this.#isEstimatePublicationQueued = true;
    // One microtask after the observer's callback: every row it reported has been accepted.
    queueMicrotask(() => {
      this.#isEstimatePublicationQueued = false;
      if (this.anchor.state.mode !== "following") {
        return;
      }
      if (this.measurements.publishEstimates()) {
        this.#virtualizer?.measure();
      }
    });
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
      const previousHeadKey = this.#rowKeys[0];
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
          headInsertedCount: countInsertedBefore(retained, previousHeadKey),
          previousHeadKey,
          scrollTopPx,
        });
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

  /** A published key's index, the first for a repeated key, or `undefined` when not held. */
  #indexOfRowKey(rowKey: string): number | undefined {
    // Reversed so a repeated key keeps its first row, as an index search would.
    this.#rowIndexByKey ??= new Map(
      this.#rowKeys.map((key, index) => [key, index] as const).reverse(),
    );
    return this.#rowIndexByKey.get(rowKey);
  }

  /** Home: the log's first row at the top of the viewport, admitted first if it was let go. */
  #jumpToHead(): void {
    const headRowKey = this.rowWindow.logHeadRowKey;
    if (headRowKey !== undefined) {
      this.landOnRow(headRowKey, "jump-to-head");
    }
  }

  /** The library's own landing on the last row, which re-aims as the rows near it measure. */
  #scrollToTail(caller: ScrollCaller): void {
    const virtualizer = this.#virtualizer;
    if (virtualizer === undefined) {
      return;
    }
    this.virtualizerOptions.scrollFor(caller, () => {
      virtualizer.scrollToEnd();
    });
  }

  /**
   * Retires the library's running scroll when the reader stops following by their own act (a
   * scroll toward the head, a page of history, a link's landing) rather than inside a write this
   * frame made. A tail landing re-aims every frame the last row grows, and nothing in the library
   * cancels it on a gesture, so it would pull the reader back for up to five seconds.
   */
  #noteReadingMode(mode: ReadingMode): void {
    const wasFollowing = this.#isFollowingTail;
    this.#isFollowingTail = mode === "following";
    const virtualizer = this.#virtualizer;
    // `vetoesPrune` answers whether a programmatic glide is in flight: one that moved the reader
    // off the tail is a jump, whose own scroll replaced the library's.
    if (
      !wasFollowing ||
      this.#isFollowingTail ||
      virtualizer === undefined ||
      this.scroll.vetoesPrune()
    ) {
      return;
    }
    this.virtualizerOptions.retireLibraryScroll(virtualizer);
  }

  #buildSnapshot(): ViewportSnapshot {
    const { mode, newRowCount } = this.anchor.state;
    return {
      rows: this.#rows,
      rowKeys: this.#rowKeys,
      keyProjection: this.measurements.projectKeys(this.#rowKeys),
      reading: { mode, newRowCount },
      lastPrune: this.#pruneCycle.lastOutcome,
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

/** Whether a key was pressed with a modifier, which makes it a chord rather than a plain key. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * Who lands the reader on one row: a link to a message, a find step, or Home. Only a link's
 * landing takes focus; the others keep it where the person pressed.
 */
type RowLandingCaller = Extract<ScrollCaller, "message-anchor" | "find-match" | "jump-to-head">;

/** What starts one pass of the window: the side a reader's approach admits on, and who asked. */
interface WindowPass {
  readonly admitSide: WindowSide | undefined;
  readonly isRender: boolean;
}

/** A pass the controller runs itself, outside a render, with no side to admit on. */
const OWN_PASS: WindowPass = { admitSide: undefined, isRender: false };
