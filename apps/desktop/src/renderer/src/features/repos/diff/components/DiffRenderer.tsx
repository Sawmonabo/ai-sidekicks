// Review's diff renderer: one virtualized scroller of file headers and rows, the pane's one
// vertical scroller. It owns rows (scroller, window, spacers); the pane owns its chrome. It holds
// no diff state, mounts diff text only as text, wraps long lines, and computes intraline segments
// per drawn row from a cache, so virtualization bounds the cost as well as the DOM. The flow draws
// the same rows without a scroller (`InlineDiffBlock.tsx`).

import "./DiffRenderer.css";

import { useId, useMemo, useRef } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { useRowWindow } from "#renderer/hooks/useRowWindow.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import {
  DIFF_ROW_HEIGHT_PX,
  DIFF_VIEWPORT_FALLBACK_HEIGHT_PX,
  DIFF_WINDOW_OVERSCAN_ROWS,
} from "../measures.js";
import type { DiffModel, DiffViewMode } from "../model.js";
import { DiffRowView } from "./DiffRowView.js";
import type { DiffGapExpansion } from "../rows/model.js";
import { DiffRowIndex } from "../rows/flat-index.js";
import { useIntralineSegmentCache } from "../hooks/useIntralineSegmentCache.js";

/** Props for `DiffRenderer`. */
export interface DiffRendererProps {
  readonly model: DiffModel;
  readonly viewMode: DiffViewMode;
  readonly expansion: DiffGapExpansion;
  /**
   * Show only this file of the model, by its wire-verbatim path. A filter, not a smaller
   * model, so `fileIndex` on rows and in `onExpandGap` still addresses `model.files`.
   */
  readonly shownFilePath?: string | undefined;
  readonly onExpandGap: (fileIndex: number, hunkIndex: number) => void;
  /** The scroller's accessible name. Its host knows what this diff is of. */
  readonly label: string;
}

/** The diff as one virtualized scroller of file headers and rows. */
export function DiffRenderer(props: DiffRendererProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerScrollbarRef = useDrawOverlayScrollbar(scrollerRef);
  const scrollerId = useId();
  const clock = useBridgeClock();

  // Re-flattened only when the diff, expansion, shown file or view mode changes, not per scroll.
  // Split view pairs a deletion with its insertion, so the two modes differ in row count.
  const index = useMemo(
    () => new DiffRowIndex(props.model, props.expansion, props.shownFilePath, props.viewMode),
    [props.model, props.expansion, props.shownFilePath, props.viewMode],
  );

  const intraline = useIntralineSegmentCache(props.model);

  // Rows are measured, not fixed-height: a wrapped line makes a row taller than the estimate.
  // The window's compensation for a taller row above the fold is its one scroll write past the
  // opening, and both go through the scroll chokepoint.
  const { virtualizer } = useRowWindow({
    rowCount: index.rowCount,
    getScrollElement: () => scrollerRef.current,
    clock,
    estimateRowHeightPx: () => DIFF_ROW_HEIGHT_PX,
    overscanRows: DIFF_WINDOW_OVERSCAN_ROWS,
    initialViewportHeightPx: DIFF_VIEWPORT_FALLBACK_HEIGHT_PX,
  });

  if (index.rowCount === 0) {
    return (
      <div className="meridian-diff meridian-diff--empty">
        <Nothing kind="empty" placement="block" title="nothing to review" />
      </div>
    );
  }

  const virtualRows = virtualizer.getVirtualItems();
  const rows: React.JSX.Element[] = [];
  for (const virtualRow of virtualRows) {
    const row = index.rowAt(virtualRow.index);
    if (row === undefined) {
      continue;
    }
    rows.push(
      <DiffRowView
        key={virtualRow.index}
        rowIndex={virtualRow.index}
        row={row}
        index={index}
        intraline={intraline}
        viewMode={props.viewMode}
        onExpandGap={props.onExpandGap}
        rowElementRef={virtualizer.measureElement}
      />,
    );
  }

  const className = `meridian-diff meridian-diff--${props.viewMode} meridian-focus-inset`;

  return (
    <div
      className={className}
      ref={scrollerScrollbarRef}
      id={scrollerId}
      // A named tab stop, so the diff can be scrolled and read with a keyboard. A group, not the
      // table, since the bar is drawn inside the scroller and a table holds only its rows; not a
      // region, which would make every diff in a conversation a landmark.
      tabIndex={0}
      role="group"
      aria-label={props.label}
      // The row height has one home, `measures.ts`; the sheet reads it from here so the
      // window arithmetic and the painted rows cannot disagree.
      style={
        { "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_PX)}px` } as React.CSSProperties
      }
    >
      {/* The content box holds the full height so the scrollbar spans the whole diff, and the
          leading spacer puts the window at its offset. Rows stay in flow rather than absolutely
          positioned, so a screen reader can walk them. A table must carry a name, so it takes
          the scroller's rather than a second copy. */}
      <div
        className="meridian-diff__content"
        role="table"
        aria-labelledby={scrollerId}
        aria-rowcount={index.rowCount}
        style={{ blockSize: virtualizer.getTotalSize() }}
      >
        <div
          className="meridian-diff__window"
          style={{ transform: `translateY(${String(virtualRows[0]?.start ?? 0)}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}
