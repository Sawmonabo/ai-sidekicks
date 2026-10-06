// A scrolled list's window: which rows a scroll position needs, at what offset, under what total
// height. Only the rows in view, plus the overscan, are drawn; every caller places its own rows.
// The window never writes its box's offset itself: each write goes through the scroll chokepoint,
// named for the opening, the reveal or the measurement compensation that made it.

import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import { type Clock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { type ScrollCaller } from "#renderer/lib/scroll/scroll-callers.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";

/** One list's window over its rows, and the one way a caller scrolls it to a row. */
export interface RowWindow {
  /** The library's window, scrolled by a `<div>` and measuring whatever element each row draws. */
  readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  /** Scroll the least distance that brings a row into view, as a row reveal. */
  readonly revealRow: (rowIndex: number) => void;
}

/** What one list's window is built over. */
export interface RowWindowOptions {
  readonly rowCount: number;
  readonly getScrollElement: () => HTMLDivElement | null;
  /** The window's clock, from `useBridgeClock()`; the box's scroll controller runs on it. */
  readonly clock: Clock;
  /** A row's height before it is measured, in CSS pixels. */
  readonly estimateRowHeightPx: (rowIndex: number) => number;
  /** Rows drawn past each edge, so a quick flick or arrow press does not meet an undrawn band. */
  readonly overscanRows: number;
  /**
   * The viewport height the window is computed against before layout runs, in CSS pixels; the
   * observed size replaces it on the next tick. Absent, it is zero until the list is measured.
   */
  readonly initialViewportHeightPx?: number;
  /**
   * Where the window opens, in CSS pixels, before anything has scrolled. Without it a list whose
   * selection is far down opens at the top; absent opens at the top.
   */
  readonly initialOffsetPx?: number;
  /**
   * A key that stays with its row when rows before it are added or removed, so a measured height
   * stays with its row; the row's index when absent.
   */
  readonly rowKey?: (rowIndex: number) => number | string;
  /** Receives the window, for a caller outside the list that scrolls it to a row. */
  readonly rowWindowRef?: React.Ref<RowWindow | null>;
}

/** Builds one list's window over its box, and hands it to `rowWindowRef` where one is given. */
export function useRowWindow(options: RowWindowOptions): RowWindow {
  const { clock, getScrollElement, initialViewportHeightPx, initialOffsetPx } = options;
  const controllerRef = useRef<ScrollController | undefined>(undefined);
  const attachedContainerRef = useRef<HTMLDivElement | undefined>(undefined);
  // Whom the library's next write is made for; a write outside an opening or a reveal is the
  // library compensating for a row measured above the fold.
  const writeCallerRef = useRef<ScrollCaller | undefined>(undefined);

  // Layout effects, so the box is held before the library's own layout effect writes to it.
  useLayoutEffect(() => {
    const controller = new ScrollController({ clock });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = undefined;
      attachedContainerRef.current = undefined;
      controller.dispose();
    };
  }, [clock]);
  // Every commit, because the box can appear after mount: an empty diff draws no scroller.
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    const scrollContainer = getScrollElement() ?? undefined;
    if (controller === undefined || scrollContainer === attachedContainerRef.current) {
      return;
    }
    attachedContainerRef.current = scrollContainer;
    if (scrollContainer === undefined) {
      controller.detach();
      return;
    }
    controller.attach(scrollContainer);
    // The library puts a box it takes at the offset it holds, the opening one before any scroll.
    writeCallerRef.current = "window-opening";
  });

  const scrollToFn = useCallback(
    (offset: number, writeOptions: { adjustments?: number | undefined }) => {
      // Rows attach and measure before this hook's layout effects run, so a first-commit write
      // can arrive with no controller, when the library holds no box either.
      controllerRef.current?.glideTo(
        writeCallerRef.current ?? "measurement-compensation",
        offset + (writeOptions.adjustments ?? 0),
      );
    },
    [],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: options.rowCount,
    getScrollElement,
    estimateSize: options.estimateRowHeightPx,
    ...(options.rowKey === undefined ? {} : { getItemKey: options.rowKey }),
    overscan: options.overscanRows,
    indexAttribute: WINDOWED_ROW_INDEX_ATTRIBUTE,
    // React 19 warns when a virtualizer flushes synchronously from a lifecycle method, and no
    // scroll tick here must land in the same commit as its event.
    useFlushSync: false,
    scrollToFn,
    ...(initialViewportHeightPx === undefined
      ? {}
      : { initialRect: { width: 0, height: initialViewportHeightPx } }),
    ...(initialOffsetPx === undefined ? {} : { initialOffset: initialOffsetPx }),
  });
  // After the library's layout effect: an opening write it made has landed by now.
  useLayoutEffect(() => {
    writeCallerRef.current = undefined;
  });

  const revealRow = useCallback(
    (rowIndex: number) => {
      writeCallerRef.current = "row-reveal";
      try {
        virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      } finally {
        writeCallerRef.current = undefined;
      }
    },
    [virtualizer],
  );
  const rowWindow = useMemo(() => ({ virtualizer, revealRow }), [virtualizer, revealRow]);
  useImperativeHandle(options.rowWindowRef, () => rowWindow, [rowWindow]);
  return rowWindow;
}
