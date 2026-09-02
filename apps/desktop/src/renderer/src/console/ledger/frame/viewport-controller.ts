// What holds the ledger frame's four objects together, and the hook a view reads it
// through.
//
// The scroll chokepoint, the reading anchor, the row window, and the window cap are
// each one idea and each testable alone. They are also useless alone: the anchor
// decides where the reader is and only the chokepoint can hold them there; the row
// window knows every row's offset and the anchor is the only thing that knows which
// offset matters. This class is that wiring and nothing else — every rule it obeys
// lives in one of the four.
//
// TWO PROPERTIES WORTH NAMING:
//
//   • **The anchor is captured from the prefix sum, never from the DOM.** The row a
//     reader is looking at and its offset both fall out of the row window's own
//     offsets, so holding a reading position costs no element read at all — which
//     is what lets `Spec-023 §Console Design (Meridian)` §5.8's "no hit test per
//     scroll event while following" hold without a special case for the anchor.
//   • **A snapshot is a value, recomputed on change.** `useSyncExternalStore`
//     demands a stable reference between changes, and recomputing one per render
//     would tear the tree. Every producer routes through `#publish`, which rebuilds
//     the snapshot once and notifies once.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import { ReadingAnchor, type ReadingAnchorState } from "./reading-anchor.js";
import { RowWindow, type RowWindowRange } from "./row-window.js";
import {
  LedgerScrollController,
  type LedgerGeometry,
  type LedgerScrollSurface,
} from "./scroll-chokepoint.js";
import { LedgerWindow, type LedgerWindowRow, type PruneOutcome } from "./window-cap.js";

/**
 * One row, as the viewport addresses it.
 *
 * The window's own row type under the name the view uses for it — an alias rather
 * than a second declaration, because the viewport and the window must agree about
 * what a row IS or the cap applies to a different set than the list renders.
 */
export type LedgerViewportRow = LedgerWindowRow;

/** Everything a render of the viewport needs, in one stable value. */
export interface LedgerViewportSnapshot {
  readonly rows: readonly LedgerViewportRow[];
  readonly rowKeys: readonly string[];
  readonly range: RowWindowRange;
  readonly reading: ReadingAnchorState;
  readonly geometry: LedgerGeometry | undefined;
  readonly lastPrune: PruneOutcome | undefined;
}

/** What the surrounding surface tells the frame each render. */
export interface LedgerViewportConditions {
  readonly rows: readonly LedgerViewportRow[];
  /** A turn is mid-flight, so prune waits rather than moving rows under a stream. */
  readonly hasActiveTurn: boolean;
  /** The reveal engine still has characters queued for this frame. */
  readonly isRevealDraining: boolean;
}

export interface LedgerViewportControllerOptions {
  readonly clock: ConsoleClock;
}

export class LedgerViewportController {
  readonly scroll: LedgerScrollController;
  readonly anchor: ReadingAnchor;
  readonly rowWindow: RowWindow;
  readonly window: LedgerWindow;

  readonly #clock: ConsoleClock;
  readonly #changeEmitter = new Emitter<void>("ledger viewport snapshot");
  readonly #teardown: Unsubscribe[] = [];

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
    this.rowWindow = new RowWindow();
    this.window = new LedgerWindow();
    this.#snapshot = this.#buildSnapshot();
    this.#teardown.push(
      this.scroll.subscribeToGeometry((geometry) => {
        this.anchor.observeGeometry(geometry);
        this.#captureAnchorPoint(geometry);
        this.#publish();
      }),
      this.anchor.subscribe(() => {
        this.#publish();
      }),
      this.scroll.observeOverflow(() => {
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
  }

  public detach(): void {
    this.scroll.detach();
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
    this.window.ingest(conditions.rows);
    this.#lastPrune = this.window.prune({
      hasActiveTurn: conditions.hasActiveTurn,
      scrollControllerVetoes: this.scroll.vetoesPrune(),
      revealDrainInFlight: conditions.isRevealDraining,
      pinnedRootCursor: this.anchor.state.pinnedRootCursor,
      heldRowKeys: this.anchor.heldRowKeys(),
    });
    for (const prunedKey of this.#lastPrune.prunedKeys) {
      this.rowWindow.forget(prunedKey);
    }
    const retained = this.window.rows();
    const appendedCount = this.#countAppendedAfter(retained, previousTailKey);
    this.#rows = retained;
    this.#rowKeys = retained.map((row) => row.key);
    if (appendedCount > 0) {
      this.anchor.noteAppendedRows(appendedCount);
    }
    this.holdReadingPosition();
    this.#publish();
  }

  /**
   * Put the reader back where they were, if they had left the tail.
   *
   * While following, the tail is the position, so the frame glides there instead —
   * which is the one case where the ledger moves the offset on its own, and it does
   * it only because the reader asked for it by being at the tail.
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
    const offset = this.rowWindow.offsetOf(this.#rowKeys, index);
    this.scroll.glideTo("hold-reading-position", offset - anchorPoint.offsetWithinViewportPx);
  }

  /** The tail pill and the keyboard's jump. */
  public jumpToTail(): void {
    this.anchor.resumeFollowing();
    this.scroll.glideToTail("jump-to-tail");
  }

  /** One row's measured height. Publishing is batched onto the next frame. */
  public measureRow(rowKey: string, heightPx: number): void {
    if (this.rowWindow.measure(rowKey, heightPx)) {
      this.#schedulePublish();
    }
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
    this.#disposed = true;
  }

  /**
   * Which row the reader is looking at, and how far down the viewport it sits.
   *
   * Read from the prefix sum rather than from the DOM: no element is touched, so
   * this is affordable on the scroll path.
   */
  #captureAnchorPoint(geometry: LedgerGeometry): void {
    if (geometry.isAtTail || this.#rowKeys.length === 0) {
      return;
    }
    const range = this.rowWindow.rangeFor(
      this.#rowKeys,
      geometry.scrollTop,
      geometry.viewportHeight,
    );
    const rowKey = this.#rowKeys[range.startIndex];
    if (rowKey === undefined) {
      return;
    }
    this.anchor.capture({
      rowKey,
      offsetWithinViewportPx:
        this.rowWindow.offsetOf(this.#rowKeys, range.startIndex) - geometry.scrollTop,
    });
  }

  /** How many rows arrived after the row that used to be last. */
  #countAppendedAfter(
    rows: readonly LedgerViewportRow[],
    previousTailKey: string | undefined,
  ): number {
    if (previousTailKey === undefined) {
      return 0;
    }
    const previousTailIndex = rows.findIndex((row) => row.key === previousTailKey);
    return previousTailIndex < 0 ? 0 : rows.length - previousTailIndex - 1;
  }

  #buildSnapshot(): LedgerViewportSnapshot {
    const geometry = this.scroll.geometry;
    return {
      rows: this.#rows,
      rowKeys: this.#rowKeys,
      range: this.rowWindow.rangeFor(
        this.#rowKeys,
        geometry?.scrollTop ?? 0,
        geometry?.viewportHeight ?? 0,
      ),
      reading: this.anchor.state,
      geometry,
      lastPrune: this.#lastPrune,
    };
  }

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    this.#changeEmitter.emit(undefined);
  }

  /**
   * Coalesce a burst of row measurements into one publish.
   *
   * Fifty rows mounting in one pass would otherwise be fifty snapshots and fifty
   * renders; through the clock's frame seam they are one. Nothing here polls: the
   * frame is armed by a measurement and never re-armed on its own.
   */
  #schedulePublish(): void {
    if (this.#publishFrame !== undefined || this.#disposed) {
      return;
    }
    this.#publishFrame = this.#clock.scheduleFrame(() => {
      this.#publishFrame = undefined;
      this.#publish();
    });
  }

  #cancelPublishFrame(): void {
    if (this.#publishFrame === undefined) {
      return;
    }
    this.#clock.cancel(this.#publishFrame);
    this.#publishFrame = undefined;
  }
}

/** What the view gets back: a snapshot, the surface ref, and the two acts it offers. */
export interface LedgerViewportBinding {
  readonly snapshot: LedgerViewportSnapshot;
  readonly attachSurface: (element: HTMLElement | null) => void;
  readonly measureRow: (rowKey: string, element: HTMLElement | null) => void;
  readonly jumpToTail: () => void;
}

export interface UseLedgerViewportOptions extends LedgerViewportConditions {
  /**
   * The clock every timer in this frame is minted through. Fixed for the mount:
   * a viewport that swapped clocks mid-life would have work armed on one and
   * cancelled on another.
   */
  readonly clock: ConsoleClock;
}

/**
 * Bind a viewport controller to a React tree.
 *
 * `rows` is expected to be MEMOIZED by the caller. The reconcile effect keys on its
 * identity, and so does the row window's prefix-sum cache, so a caller that rebuilds
 * the array every render reconciles every render — a cost the caller controls and
 * this hook documents, rather than a deep compare performed on its behalf.
 *
 * The re-mint arm is `frame/session-lifecycle.ts`' idiom, for its reason: a remount
 * of the same component instance — React's StrictMode double-mount is the one that
 * does it today — has already run the cleanup, and a disposed controller attaches
 * nothing, so the second mount takes a fresh one rather than a corpse.
 */
export function useLedgerViewport(options: UseLedgerViewportOptions): LedgerViewportBinding {
  const { clock, rows, hasActiveTurn, isRevealDraining } = options;
  const [controller, setController] = useState<LedgerViewportController>(
    () => new LedgerViewportController({ clock }),
  );

  useEffect(() => {
    if (controller.isDisposed) {
      setController(new LedgerViewportController({ clock }));
      return;
    }
    return () => {
      controller.dispose();
    };
  }, [controller, clock]);

  const snapshot = useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribe(onChange), [controller]),
    useCallback(() => controller.snapshot(), [controller]),
  );

  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.reconcile({ rows, hasActiveTurn, isRevealDraining });
  }, [controller, rows, hasActiveTurn, isRevealDraining]);

  return {
    snapshot,
    attachSurface: useCallback(
      (element: HTMLElement | null) => {
        if (element === null) {
          controller.detach();
          return;
        }
        controller.attach(element);
      },
      [controller],
    ),
    measureRow: useCallback(
      (rowKey: string, element: HTMLElement | null) => {
        if (element !== null) {
          controller.measureRow(rowKey, element.offsetHeight);
        }
      },
      [controller],
    ),
    jumpToTail: useCallback(() => {
      controller.jumpToTail();
    }, [controller]),
  };
}
