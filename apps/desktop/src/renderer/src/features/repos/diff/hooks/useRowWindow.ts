// The window shared by both diff scrollers (the diff rows and the changed-file list): which
// rows a scroll position needs, at what offset, under what total height. They share the
// overscan, the pre-measurement viewport and the no-flush setting, but each places its own
// rows, since a file entry is an `<li>` of a real list. The row height is the caller's: each
// list paints rows at a height `diff-measures.ts` names, and the estimate is that number.

import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import { DIFF_VIEWPORT_FALLBACK_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "../diff-measures.js";

/** One scroller's window. `HTMLDivElement` on both axes, as both scrollers are. */
export type RowWindow = Virtualizer<HTMLDivElement, HTMLDivElement>;

/** Options for one scroller's window. */
export interface RowWindowOptions {
  readonly rowCount: number;
  readonly getScrollElement: () => HTMLDivElement | null;
  /** What the sheet paints one row at, so an unmeasured window is exact. */
  readonly estimatedRowHeightPx: number;
  /**
   * Where the window opens, in CSS pixels, before anything has scrolled. Without it a list
   * whose selection is far down opens at the top; absent opens at the top.
   */
  readonly initialOffsetPx?: number;
}

/** Build one scroller's window on the console's shared bounds. */
export function useRowWindow(options: RowWindowOptions): RowWindow {
  const { estimatedRowHeightPx, initialOffsetPx } = options;
  return useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: options.rowCount,
    getScrollElement: options.getScrollElement,
    estimateSize: () => estimatedRowHeightPx,
    overscan: DIFF_WINDOW_OVERSCAN_ROWS,
    // The window is computed against this before layout runs; the observed rect replaces it
    // on the next tick.
    initialRect: { width: 0, height: DIFF_VIEWPORT_FALLBACK_HEIGHT_PX },
    // React 19 warns when a virtualizer flushes synchronously from a lifecycle method, and no
    // scroll tick here must land in the same commit as its event.
    useFlushSync: false,
    ...(initialOffsetPx === undefined ? {} : { initialOffset: initialOffsetPx }),
  });
}
