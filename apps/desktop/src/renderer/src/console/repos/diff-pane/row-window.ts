// The window itself: which rows a scroll position needs, at what offset, under what
// total height.
//
// ONE ADOPTION SITE FOR TWO SCROLLERS. `Spec-023 §Console Libraries` ADOPTs
// `@tanstack/react-virtual` with constraints, and this family has two lists long
// enough to need it: the rows of a diff, and the CHANGED-FILE LIST beside them. The
// file list used to add a scrolling class past its threshold and mount every entry
// anyway, so a repository-wide patch cost thousands of buttons before the already
// virtualized body could help — and every keystroke in the filter rebuilt all of
// them. Whatever the second scroller needed, it was not a second virtualizer:
// `apps/desktop/AGENTS.md` hoists a helper on its second use, and the three bounds
// below are exactly the decisions that must not be made twice.
//
// WHAT IS SHARED IS THE CONFIGURATION, NOT THE PLACEMENT. Both callers take the same
// overscan band, the same pre-measurement viewport, and the same refusal to flush
// synchronously; each places its own rows, because a diff row is a generic box in a
// two-box flow and a file entry is an `<li>` of a real list, and the second keeps its
// list semantics only by staying one.
//
// THE ROW HEIGHT IS THE CALLER'S, because it is a fact about that caller's sheet:
// each list paints its rows at a height `diff-bounds.ts` names, and the estimate is
// that same number, so an unmeasured window is exact rather than approximate.

import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import { DIFF_VIEWPORT_FALLBACK_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "./diff-bounds.js";

/** One scroller's window. `HTMLDivElement` on both axes, as both scrollers are. */
export type RowWindow = Virtualizer<HTMLDivElement, HTMLDivElement>;

export interface RowWindowOptions {
  readonly rowCount: number;
  readonly getScrollElement: () => HTMLDivElement | null;
  /** What the sheet paints one row at, so an unmeasured window is exact. */
  readonly estimatedRowHeightPx: number;
  /**
   * Where the window opens, in CSS pixels, before anything has scrolled.
   *
   * The `initialRect` bound's sibling and for the same reason: a first paint happens
   * before any scroll can, so a list whose selection is a thousand rows down would
   * otherwise open at the top and only reach the selection once something asked it
   * to. Absent opens at the top, which is every list with nothing selected.
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
    // A first paint happens before any layout callback runs, so the window has to be
    // computed against something; this bound says which something, and the observed
    // rect replaces it on the very next tick.
    initialRect: { width: 0, height: DIFF_VIEWPORT_FALLBACK_HEIGHT_PX },
    // React 19 warns when a virtualizer flushes synchronously from a lifecycle
    // method, and the console has no frame where a scroll tick must land in the same
    // commit as the event that caused it.
    useFlushSync: false,
    ...(initialOffsetPx === undefined ? {} : { initialOffset: initialOffsetPx }),
  });
}
