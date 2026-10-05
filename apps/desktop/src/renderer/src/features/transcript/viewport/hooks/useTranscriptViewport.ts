// React binding for the transcript viewport: creates the virtualizer and exposes what a view reads.
//
// `useFlushSync: false` and `directDomUpdates` exist only on `@tanstack/react-virtual`'s hook, so
// the instance is created here; nearly all of its options are the controller's virtualizer options.

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

import { type Clock } from "@renderer/lib/clock.js";
import { type TranscriptWindowReading } from "@renderer/lib/transcript-window-diagnostics.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "@renderer/lib/windowed-row-markers.js";
import { TRANSCRIPT_OVERSCAN_ROWS } from "../viewport-constants.js";
import { ViewportController } from "../viewport-controller.js";
import { type RetainedRowState } from "../retained-row-state-table.js";
import { type ViewportConditions, type ViewportSnapshot } from "../viewport-snapshot.js";

/** What the view gets back: a snapshot, the refs, and the acts it offers. */
export interface TranscriptViewportBinding {
  readonly snapshot: ViewportSnapshot;
  readonly virtualItems: readonly VirtualItem[];
  readonly attachScrollContainer: (element: HTMLElement | null) => void;
  /** The size container the virtualizer writes the total height onto. */
  readonly attachSizer: (element: HTMLElement | null) => void;
  /** One row's element, handed to the library's own measurement observer. */
  readonly attachRow: (element: HTMLElement | null) => void;
  readonly jumpToTail: () => void;
  /**
   * Scrolls one row into view by key; does nothing if the window no longer holds it.
   *
   * Keyed because an index goes stale when a prune runs between the caller reading and acting on
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
   * The state a row body parked on this window, live or re-parked after a prune.
   * Survives an unmount and a prune, up to the parked state cap.
   */
  readonly retainedRowState: (rowKey: string) => RetainedRowState | undefined;
  /** Park one row body's state on the window. */
  readonly setRetainedRowState: (rowKey: string, state: RetainedRowState) => void;
  /**
   * What this window is showing, read when called; stable across renders.
   * A function, not a snapshot member: it is mostly layout, and publishing it through React
   * would re-render on every scrolled pixel.
   */
  readonly readWindowDiagnostics: () => TranscriptWindowReading;
}

/** Inputs to `useTranscriptViewport`: the viewport conditions plus the clock. */
export interface UseTranscriptViewportOptions extends ViewportConditions {
  /** The clock every timer in this frame is minted through; fixed for the mount. */
  readonly clock: Clock;
  /**
   * The row a link to a message lands on, or `undefined` for none. Landed once per key, on the
   * first committed render that holds it, and the log takes focus there.
   */
  readonly landingRowKey?: string | undefined;
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
  const { clock, rows, hasActiveTurn, isRevealDraining, landingRowKey } = options;
  // The attached element, for the one act that needs the node. A ref because nothing renders
  // from it.
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const [controller, setController] = useState<ViewportController>(
    () => new ViewportController({ clock }),
  );

  useEffect(() => {
    if (controller.isDisposed) {
      setController(new ViewportController({ clock }));
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

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: snapshot.keyProjection.virtualKeys.length,
    overscan: TRANSCRIPT_OVERSCAN_ROWS,
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

  // A layout effect, so the landing's reading floor is set before the passive reconcile below
  // prunes: an over-cap log would otherwise lose a row far back on the very pass that brings it.
  useLayoutEffect(() => {
    if (controller.isDisposed || landingRowKey === undefined) {
      return;
    }
    controller.landOnRow(landingRowKey);
  }, [controller, landingRowKey]);

  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.reconcile({ rows, hasActiveTurn, isRevealDraining });
  }, [controller, rows, hasActiveTurn, isRevealDraining]);

  // Re-asks a prune the reconcile above could not finish. That effect depends only on the rows
  // and the two activity flags, but the window also refuses a prune while the reader is above
  // the tail, history is pinned, a programmatic scroll is mid-write, or the rows the cap wants
  // are held; none of those moves a dependency. The reading fields carry the first two, and
  // `lastPrune`'s identity carries the rest because the veto is raised and dropped inside one
  // synchronous write. It cannot spin: each landed pass leaves fewer rows over the cap, and a
  // residual whose blocker still stands answers `undefined`.
  const { mode: readingMode, pinnedRootCursor } = snapshot.reading;
  const lastPrune = snapshot.lastPrune;
  useEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.retryDeferredPrune();
  }, [controller, readingMode, pinnedRootCursor, lastPrune]);

  // Performs the deferred position hold, and a pending landing, once the height they depend on is
  // committed.
  // `reconcile` runs in a passive effect, so the sizer still has the previous total size: a
  // glide to the tail would land on the old bottom and a head hold would read a stale offset.
  // A layout effect declared after `useVirtualizer` runs after the adapter's own height write
  // and before paint, so `scrollHeight` is the fresh value. No dependency array: the height can
  // move on any render, and the call is a boolean read when nothing is armed.
  useLayoutEffect(() => {
    if (controller.isDisposed) {
      return;
    }
    controller.commitPendingPositionHold();
    // Focus goes to the log the link landed in, so the keyboard reads on from the message.
    if (controller.commitPendingLanding()) {
      scrollContainerRef.current?.focus();
    }
  });

  // A retained-state write is window state, not React state; the revision only re-renders the tree.
  const [retainedStateRevision, setRetainedStateRevision] = useState(0);

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
    attachRow: virtualizer.measureElement,
    jumpToTail: useCallback(() => {
      controller.jumpToTail();
    }, [controller]),
    // The revision is a dependency, not a read: a write mints a new reader, so every row that
    // compares it draws again.
    retainedRowState: useCallback(
      (rowKey: string) => controller.rowWindow.retainedState(rowKey),
      [controller, retainedStateRevision],
    ),
    setRetainedRowState: useCallback(
      (rowKey: string, state: RetainedRowState) => {
        controller.rowWindow.setRetainedState(rowKey, state);
        setRetainedStateRevision((current) => current + 1);
      },
      [controller],
    ),
    readWindowDiagnostics: useCallback((): TranscriptWindowReading => {
      // `getVirtualItems()` first: it recomputes the range, so `virtualizer.range` read before
      // it would be stale.
      const virtualItems = virtualizer.getVirtualItems();
      const range = virtualizer.range;
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
        totalContentHeightPx: virtualizer.getTotalSize(),
        viewportClientHeightPx: scrollContainer?.clientHeight ?? 0,
        viewportScrollHeightPx: scrollContainer?.scrollHeight ?? 0,
        rangedAgainstClientHeightPx: controller.scroll.geometry?.viewportHeight ?? 0,
      };
    }, [controller, snapshot, virtualizer]),
    jumpToRow: useCallback(
      (rowKey: string) => {
        const index = snapshot.rows.findIndex((candidate) => candidate.key === rowKey);
        if (index < 0) {
          return;
        }
        controller.virtualizerOptions.scrollFor("find-match", () => {
          virtualizer.scrollToIndex(index, { align: "center" });
        });
      },
      [controller, snapshot, virtualizer],
    ),
  };
}
