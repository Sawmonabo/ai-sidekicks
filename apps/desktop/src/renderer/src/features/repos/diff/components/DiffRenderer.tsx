// The one diff renderer, shared by the pane and the transcript card so a change reads the same
// in both. It owns rows (scroller, window, spacers); the host owns its chrome and cap. It holds
// no diff state, mounts diff text only as text, wraps long lines, and computes intraline
// segments per drawn row from a cache, so virtualization bounds the cost as well as the DOM.

import { useMemo, useRef } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useRowWindow } from "#renderer/hooks/useRowWindow.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import {
  DIFF_ROW_HEIGHT_PX,
  DIFF_VIEWPORT_FALLBACK_HEIGHT_PX,
  DIFF_WINDOW_OVERSCAN_ROWS,
} from "../measures.js";
import type { DiffModel, DiffViewMode } from "../diff-model.js";
import { DiffRowView } from "./DiffRowView.js";
import type { DiffGapExpansion } from "../row-model.js";
import { DiffRowIndex } from "../diff-row-index.js";
import { IntralineSegmentCache } from "../intraline-segment-cache.js";

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
  /** Height the scroller is capped at, in CSS pixels. The card supplies one; the pane fills. */
  readonly heightCapPx?: number;
  /** The scroller's accessible name. Its host knows what this diff is of. */
  readonly label: string;
}

/** The diff as one virtualized scroller of file headers and rows. */
export function DiffRenderer(props: DiffRendererProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const clock = useBridgeClock();

  // Re-flattened only when the diff, expansion, shown file or view mode changes, not per scroll.
  // Split view pairs a deletion with its insertion, so the two modes differ in row count.
  const index = useMemo(
    () => new DiffRowIndex(props.model, props.expansion, props.shownFilePath, props.viewMode),
    [props.model, props.expansion, props.shownFilePath, props.viewMode],
  );

  // Keyed on the model, not the index: gap expansion, narrowing and view-mode changes rebuild
  // the index without changing any line's text, so a cache tied to it would be discarded.
  const intraline = useMemo(() => new IntralineSegmentCache(props.model), [props.model]);

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
      ref={scrollerRef}
      // Focusable so the diff can be read with a keyboard.
      tabIndex={0}
      role="table"
      aria-label={props.label}
      aria-rowcount={index.rowCount}
      // The row height has one home, `measures.ts`; the sheet reads it from here so the
      // window arithmetic and the painted rows cannot disagree.
      style={
        {
          "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_PX)}px`,
          ...(props.heightCapPx === undefined ? {} : { maxBlockSize: props.heightCapPx }),
        } as React.CSSProperties
      }
    >
      {/* The content box holds the full height so the scrollbar spans the whole diff, and the
          leading spacer puts the window at its offset. Rows stay in flow rather than absolutely
          positioned, so a screen reader can walk them. */}
      <div className="meridian-diff__content" style={{ blockSize: virtualizer.getTotalSize() }}>
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
