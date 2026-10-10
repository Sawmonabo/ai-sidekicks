// React binding for the transcript viewport: creates the virtualizer and exposes what a view reads.
//
// `useFlushSync: false` and `directDomUpdates` exist only on `@tanstack/react-virtual`'s hook, so
// the instance is created here; nearly all of its options are the controller's virtualizer options.
// The two that change with the reading state, the end anchor and the landing on appended rows,
// are set here from the snapshot, so a follower's position is the library's own.

import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import { type ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type TranscriptWindowReading } from "#renderer/lib/transcript-window-diagnostics.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { type RowHeightKind } from "../../rows/height-kind.js";
import { ViewportController, type ViewportControllerOptions } from "../controller.js";
import { type ViewportConditions, type ViewportSnapshot } from "../snapshot.js";
import { type WindowSide } from "../window-cap.js";
import { useObserveDisplaySettings } from "./useObserveDisplaySettings.js";

/** What the view gets back: a snapshot, the refs, and the acts it offers. */
export interface TranscriptViewportBinding {
  readonly snapshot: ViewportSnapshot;
  readonly virtualItems: readonly VirtualItem[];
  readonly attachScrollContainer: (element: HTMLElement | null) => void;
  /** The size container the virtualizer writes the total height onto. */
  readonly attachSizer: (element: HTMLElement | null) => void;
  /**
   * The box of the history line above the first row, whose height the list starts below; see
   * `ViewportController.attachHead`. Returns its own detach, as a React ref callback may.
   */
  readonly attachHead: (element: HTMLElement | null) => (() => void) | undefined;
  /** One row's element, handed to the library's own measurement observer. */
  readonly attachRow: (element: HTMLElement | null) => void;
  readonly jumpToTail: () => void;
  /**
   * Scrolls one row of the log into the middle of the view by key, as a find step does: a row the
   * window let go is landed on, the window centering on it. Does nothing for a key the log lacks.
   *
   * Keyed because an index goes stale when a pass runs between the caller reading and acting on
   * it. Routed through the virtualizer's `scrollToIndex`, which the controller binds to the
   * scroll chokepoint; the write is a find match's.
   */
  readonly jumpToRow: (rowKey: string) => void;
  /**
   * Puts keyboard focus back on the log for a caller that took it (the find field's close).
   * Without it focus falls to `body` and the next Tab restarts from the top of the document.
   */
  readonly focusScrollContainer: () => void;
  /**
   * Keeps one row where it stands on screen through a press that changes heights in or around
   * it, and stops following the tail; see `ViewportController.holdRowInPlace`. Call it before the
   * change the press makes. Stable for the binding's controller.
   */
  readonly holdRowInPlace: (rowKey: string, control?: HTMLElement) => void;
  /**
   * Keeps the row nearest the middle of the view where it stands through a change no control was
   * pressed for, holding the nearest row `survives` keeps; see
   * `ViewportController.holdRowNearestMiddle`. Stable for the binding's controller.
   */
  readonly holdRowNearestMiddle: (survives: (rowKey: string) => boolean) => void;
  /**
   * What this window is showing, read when called; stable across renders.
   * A function, not a snapshot member: it is mostly layout, and publishing it through React
   * would re-render on every scrolled pixel.
   */
  readonly readWindowDiagnostics: () => TranscriptWindowReading;
  /**
   * The one writer of this log's scroll offset, for a row body that moves it or reads its
   * geometry; stable for the binding's controller.
   */
  readonly scrollController: ScrollController;
  /**
   * A row's top edge in the scroller's content, in pixels, from the virtualizer's measurements,
   * read when called and reading no element; `undefined` when the window does not hold the row.
   */
  readonly rowStartPx: (rowKey: string) => number | undefined;
  /**
   * The height a row the feed has not drawn yet would be laid out at, from its kind and body
   * length; see `RowMeasurementTable.estimatedHeightOf`. Stable for the binding's controller.
   */
  readonly estimatedRowHeightPx: (
    rowKey: string,
    kind: RowHeightKind,
    bodyLength: number | undefined,
  ) => number;
  /** The least height any drawn row is estimated at, read when called; stable likewise. */
  readonly smallestRowHeightPx: () => number;
}

/**
 * Inputs to `useTranscriptViewport`: the viewport conditions, the clock, and where row heights
 * are remembered and how a row's kind and body length are told. A new clock, record or reader
 * mints a new controller.
 */
export interface UseTranscriptViewportOptions extends ViewportConditions {
  /** The clock every timer in this frame is minted through; fixed for the mount. */
  readonly clock: Clock;
  /**
   * The session's record of its row heights, which outlives this mount, so the rows of a
   * transcript opened again are laid out at the heights they had. One per mount when omitted.
   */
  readonly rememberedRowHeights?: RememberedRowHeights | undefined;
  /** The height kind the feed draws a row key as, which picks an unmeasured row's estimate. */
  readonly heightKindOf?: ((rowKey: string) => RowHeightKind) | undefined;
  /**
   * The UTF-8 byte length of the body the feed draws for a row key, which places an unmeasured
   * row on its kind's line of height on body length.
   */
  readonly bodyLengthOf?: ((rowKey: string) => number | undefined) | undefined;
  /**
   * The row a link to a message lands on, or `undefined` for none. Landed once per key, on the
   * first committed render that holds it, and the log takes focus there.
   */
  readonly landingRowKey?: string | undefined;
  /**
   * Asks for the stretch past an edge of the log; see `ViewportControllerOptions`. Read when
   * called, so a new function does not mint a new controller.
   */
  readonly readBeyondLogEdge?: ((side: WindowSide) => boolean) | undefined;
}

/**
 * Binds a viewport controller and a virtualizer to a React tree.
 *
 * `rows` must be memoized by the caller: the reconcile effect and the measurement key projection
 * key on its identity. A remount of the same instance (StrictMode) has already run the cleanup
 * and a disposed controller attaches nothing, so the effect creates a fresh controller.
 */
export function useTranscriptViewport(
  options: UseTranscriptViewportOptions,
): TranscriptViewportBinding {
  const {
    clock,
    rows,
    isWorkingRow,
    landingRowKey,
    rememberedRowHeights,
    heightKindOf,
    bodyLengthOf,
  } = options;
  // The attached element, for the one act that needs the node. A ref because nothing renders
  // from it.
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const latestReadBeyondLogEdge = useLatestRef(options.readBeyondLogEdge);
  const [controller, setController] = useState<ViewportController>(() =>
    mintViewportController(
      { clock, rememberedRowHeights, heightKindOf, bodyLengthOf },
      latestReadBeyondLogEdge,
    ),
  );

  useEffect(() => {
    if (controller.isDisposed) {
      setController(
        mintViewportController(
          { clock, rememberedRowHeights, heightKindOf, bodyLengthOf },
          latestReadBeyondLogEdge,
        ),
      );
      return;
    }
    return () => {
      controller.dispose();
    };
  }, [
    controller,
    clock,
    rememberedRowHeights,
    heightKindOf,
    bodyLengthOf,
    latestReadBeyondLogEdge,
  ]);
  useObserveDisplaySettings(controller);

  const snapshot = useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribe(onChange), [controller]),
    useCallback(() => controller.snapshot(), [controller]),
  );

  const isFollowing = snapshot.reading.mode === "following";
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: snapshot.keyProjection.virtualKeys.length,
    // The band drawn beyond the box is measured in pixels by the range extractor, not in rows.
    overscan: 0,
    rangeExtractor: controller.virtualizerOptions.rangeExtractor,
    // Named here rather than left to the library's same-spelled default: a rename in the row
    // primitive would otherwise measure every row as row zero with nothing to notice.
    indexAttribute: WINDOWED_ROW_INDEX_ATTRIBUTE,
    estimateSize: controller.virtualizerOptions.estimateSize,
    getItemKey: controller.virtualizerOptions.getItemKey,
    getScrollElement: controller.virtualizerOptions.getScrollElement,
    scrollToFn: controller.virtualizerOptions.scrollToFn,
    observeElementOffset: controller.virtualizerOptions.observeElementOffset,
    observeElementRect: controller.virtualizerOptions.observeElementRect,
    measureElement: controller.virtualizerOptions.measureElement,
    // The history line sits above the sizer in the box, so the rows start below it.
    scrollMargin: snapshot.headHeightPx,
    // While the reader follows, the library holds the tail as rows measure and lands on each
    // appended row; otherwise the reading anchor holds the position and the library holds none.
    anchorTo: isFollowing ? "end" : "start",
    followOnAppend: isFollowing,
    scrollEndThreshold: controller.virtualizerOptions.scrollEndThreshold,
    // React 19 warns when the adapter flushes inside a lifecycle method, and offsets are written
    // to the DOM directly, so the render is not needed.
    useFlushSync: false,
    // Scroll ticks skip React: the adapter writes row transforms and the container height, and
    // re-renders only when the index range moves.
    directDomUpdates: true,
  });

  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.bindVirtualizer(virtualizer);
  }, [controller, virtualizer]);

  // A layout effect, so the landing's reading position is set before the passive reconcile below
  // runs: the window would otherwise center on wherever the reader was, not on the row.
  // Landed once per key and controller: the key goes `undefined` while its row is folded away or
  // let go, and its return must not pull the reader back or take focus from where they are.
  const landed = useRef<{ readonly controller: ViewportController; readonly rowKey: string }>(
    undefined,
  );
  useLayoutEffect(() => {
    if (controller.isDisposed || landingRowKey === undefined) {
      return;
    }
    if (landed.current?.controller === controller && landed.current.rowKey === landingRowKey) {
      return;
    }
    landed.current = { controller, rowKey: landingRowKey };
    controller.landOnRow(landingRowKey, "message-anchor");
  }, [controller, landingRowKey]);

  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.reconcile({ rows, isWorkingRow });
  }, [controller, rows, isWorkingRow]);

  // Re-asks a cut the reconcile above could not finish. That effect depends only on the rows and
  // the working rows, but the window also stops a cut while a programmatic scroll is
  // mid-write or the rows it wants are held, on screen or under the reader; none of those moves a
  // dependency. The reading mode carries a return to the tail, and `lastPrune`'s identity the rest
  // because the veto is raised and dropped inside one synchronous write. It cannot spin: a
  // residual whose blocker still stands answers `undefined`.
  const readingMode = snapshot.reading.mode;
  const lastPrune = snapshot.lastPrune;
  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.retryDeferredPrune();
  }, [controller, readingMode, lastPrune]);

  // Performs the deferred holds, and a pending landing, once the height they depend on is
  // committed.
  // `reconcile` runs in a passive effect, so the sizer still has the previous total size and a
  // head hold would read a stale offset. A layout effect declared after `useVirtualizer` runs
  // after the adapter's own height write and before paint, so the offsets are the fresh ones. No
  // dependency array: the height can move on any render, and the call is a boolean read when
  // nothing is armed.
  useLayoutEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.commitPendingPositionHold(rows);
    // Focus goes to the log a link landed in, so the keyboard reads on from the message.
    if (controller.commitPendingLanding() === "message-anchor") {
      scrollContainerRef.current?.focus();
    }
  });

  // A press's hold is window state, not React state; the count only re-renders the tree, so the
  // layout effect above performs the hold after a press whose change is the row's own.
  const [, setHeldPressCount] = useState(0);

  const virtualItems = virtualizer.getVirtualItems();

  return {
    snapshot,
    virtualItems,
    attachScrollContainer: useCallback(
      (element: HTMLElement | null) => {
        scrollContainerRef.current = element;
        if (element === null) {
          controller.detach();
          return;
        }
        controller.attach(element);
      },
      [controller],
    ),
    focusScrollContainer: useCallback(() => {
      scrollContainerRef.current?.focus();
    }, []),
    attachSizer: virtualizer.containerRef,
    attachHead: useCallback(
      (element: HTMLElement | null) =>
        element === null ? undefined : controller.attachHead(element),
      [controller],
    ),
    attachRow: virtualizer.measureElement,
    jumpToTail: useCallback(() => {
      controller.jumpToTail();
    }, [controller]),
    scrollController: controller.scroll,
    rowStartPx: useCallback((rowKey: string) => controller.rowStartPx(rowKey), [controller]),
    estimatedRowHeightPx: useCallback(
      (rowKey: string, kind: RowHeightKind, bodyLength: number | undefined) =>
        controller.measurements.estimatedHeightOf(rowKey, kind, bodyLength),
      [controller],
    ),
    smallestRowHeightPx: useCallback(
      () => controller.measurements.smallestEstimatePx,
      [controller],
    ),
    holdRowInPlace: useCallback(
      (rowKey: string, control?: HTMLElement) => {
        controller.holdRowInPlace(rowKey, control);
        setHeldPressCount((current) => current + 1);
      },
      [controller],
    ),
    holdRowNearestMiddle: useCallback(
      (survives: (rowKey: string) => boolean) => {
        controller.holdRowNearestMiddle(survives);
        setHeldPressCount((current) => current + 1);
      },
      [controller],
    ),
    readWindowDiagnostics: useCallback((): TranscriptWindowReading => {
      // `getVirtualItems()` first: it recomputes the range, so `virtualizer.range` read before
      // it would be stale.
      const virtualItems = virtualizer.getVirtualItems();
      const range = virtualizer.range;
      const firstDrawn = virtualItems[0];
      const lastDrawn = virtualItems[virtualItems.length - 1];
      const firstVisible =
        range === null ? undefined : virtualizer.measurementsCache[range.startIndex];
      const lastVisible =
        range === null ? undefined : virtualizer.measurementsCache[range.endIndex];
      // The element, not the chokepoint's last sample: the sample is what the library was told,
      // so it would agree with the window even when both describe a collapsed box.
      const scrollContainer = scrollContainerRef.current;
      return {
        virtualItemCount: virtualItems.length,
        // Counted under the scroll container, not the sizer, so a row placed outside the sizer
        // still counts.
        mountedRowCount:
          scrollContainer?.querySelectorAll(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`).length ?? 0,
        totalRowCount: virtualizer.options.count,
        indexableRowCount: snapshot.rows.length,
        visibleRowCount: range === null ? 0 : range.endIndex - range.startIndex + 1,
        // Each band without its outermost row: the space between that row and the box's rows.
        drawnBandPx: Math.max(
          firstDrawn === undefined || firstVisible === undefined
            ? 0
            : Math.max(0, firstVisible.start - firstDrawn.end),
          lastDrawn === undefined || lastVisible === undefined
            ? 0
            : Math.max(0, lastDrawn.start - lastVisible.end),
        ),
        totalContentHeightPx: virtualizer.options.scrollMargin + virtualizer.getTotalSize(),
        viewportClientHeightPx: scrollContainer?.clientHeight ?? 0,
        viewportScrollHeightPx: scrollContainer?.scrollHeight ?? 0,
        rangedAgainstClientHeightPx: controller.scroll.geometry?.viewportHeight ?? 0,
      };
    }, [controller, snapshot, virtualizer]),
    jumpToRow: useCallback(
      (rowKey: string) => {
        const index = snapshot.rows.findIndex((candidate) => candidate.key === rowKey);
        if (index >= 0) {
          controller.virtualizerOptions.scrollFor("find-match", () => {
            virtualizer.scrollToIndex(index, { align: "center" });
          });
          return;
        }
        if (controller.rowWindow.logHoldsRow(rowKey)) {
          controller.landOnRow(rowKey, "find-match");
        }
      },
      [controller, snapshot, virtualizer],
    ),
  };
}

/**
 * A controller over the hook's inputs, asking for history through the latest committed read, so
 * a new read function reaches the controller without minting another.
 */
function mintViewportController(
  options: Omit<ViewportControllerOptions, "readBeyondLogEdge">,
  latestReadBeyondLogEdge: React.RefObject<UseTranscriptViewportOptions["readBeyondLogEdge"]>,
): ViewportController {
  return new ViewportController({
    ...options,
    readBeyondLogEdge: (side) => latestReadBeyondLogEdge.current?.(side) ?? false,
  });
}
