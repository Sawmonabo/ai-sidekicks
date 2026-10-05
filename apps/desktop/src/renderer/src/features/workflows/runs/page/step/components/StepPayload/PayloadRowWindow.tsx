// A payload's scroll box: every row counted, only the rows in view plus the overscan drawn, so a
// large payload costs the page what a small one does. Rows are measured once drawn, so a tall
// markdown block or JSON item takes its own height; the window's compensation for a row measured
// above the fold is its one scroll write past the opening, and both go through the scroll
// chokepoint.

import "./PayloadRowWindow.css";

import { useRef } from "react";

import { useRowWindow } from "#renderer/hooks/useRowWindow.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";

/** What one payload window draws: its rows by index, and how it is named and styled. */
export interface PayloadRowWindowProps {
  readonly rowCount: number;
  /** Names the scroll box for assistive technology: `Output of Summarize`. */
  readonly label: string;
  /** The view's own row styling, beside the window's. */
  readonly className: string;
  /** A row's height before it is measured, in CSS pixels; one line of small text when absent. */
  readonly estimateRowHeightPx?: (rowIndex: number) => number;
  readonly renderRow: (rowIndex: number) => React.ReactNode;
}

/** A payload's rows in one scroll box, drawn only where the reader is. */
export function PayloadRowWindow(props: PayloadRowWindowProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const clock = useBridgeClock();
  const { virtualizer } = useRowWindow({
    rowCount: props.rowCount,
    getScrollElement: () => scrollerRef.current,
    clock,
    estimateRowHeightPx: props.estimateRowHeightPx ?? (() => PAYLOAD_ROW_ESTIMATE_PX),
    overscanRows: PAYLOAD_WINDOW_OVERSCAN_ROWS,
    initialViewportHeightPx: PAYLOAD_VIEWPORT_FALLBACK_HEIGHT_PX,
  });
  const virtualRows = virtualizer.getVirtualItems();
  return (
    <div
      ref={scrollerRef}
      className={`meridian-workflow-payload__window meridian-focus-inset ${props.className}`}
      // Focusable so a keyboard can scroll it.
      tabIndex={0}
      role="region"
      aria-label={props.label}
    >
      {/* Holds the whole height so the scrollbar spans every row; the window sits at its
          offset, and its rows stay in flow so a screen reader walks them in order. */}
      <div style={{ blockSize: virtualizer.getTotalSize() }}>
        <div style={{ transform: `translateY(${String(virtualRows[0]?.start ?? 0)}px)` }}>
          {virtualRows.map((virtualRow) => (
            <div
              key={virtualRow.index}
              {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: virtualRow.index }}
              ref={virtualizer.measureElement}
              className="meridian-workflow-payload__row"
            >
              {props.renderRow(virtualRow.index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A row's height before it is measured, in CSS pixels: one line of the panel's small text. */
export const PAYLOAD_ROW_ESTIMATE_PX = 24;

/** Rows drawn past each edge, so a quick scroll does not meet an undrawn band. */
const PAYLOAD_WINDOW_OVERSCAN_ROWS = 8;

/**
 * The viewport height assumed before the scroll box is measured. Near the box's largest height,
 * so the first frame draws about what the measured one will.
 */
const PAYLOAD_VIEWPORT_FALLBACK_HEIGHT_PX = 480;
