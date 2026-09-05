import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { RESTORE_PATH_ROW_HEIGHT_PX } from "../../core/index.js";
import { WindowedListRow } from "../../primitives/index.js";

import { RestorePathCell } from "./RestorePathCell.js";
import {
  type RestorePathListProps,
  RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX,
} from "./restore-path-window.js";

/**
 * The same paths, with only the window's worth of rows in the document.
 *
 * The scroll container is keyboard-focusable because a region that scrolls and
 * cannot be reached from the keyboard is a region half the operators cannot read,
 * and it carries the enumeration's own name so the focus stop announces what it
 * holds rather than announcing a group.
 *
 * Overscan is the library's own default: this list has no expensive row and no
 * horizontal axis, so a band picked here would be a number with no reason behind
 * it.
 */
export function WindowedRestorePathList(props: RestorePathListProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The row element is typed at the primitive's own width, because the measurement
  // callback is handed to `WindowedListRow` and a narrower parameter would not take it.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: props.paths.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => RESTORE_PATH_ROW_HEIGHT_PX,
    // A first paint happens before any layout callback runs, so the window has to
    // be computed against something; this says which something, and the observed
    // rect replaces it on the next tick.
    initialRect: { width: 0, height: RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX },
    // React 19 warns when a virtualizer flushes synchronously from a lifecycle
    // method, and no frame here needs a scroll tick to land in the commit that
    // caused it.
    useFlushSync: false,
  });

  const virtualRows = virtualizer.getVirtualItems();
  return (
    <div
      className="meridian-restore-disclosure__path-scroller"
      ref={scrollerRef}
      role="group"
      aria-label={props.label}
      tabIndex={0}
      // Only the bound is inline: it is the same constant the virtualizer measures
      // against, so the window and its arithmetic keep one home. The scroll and the
      // overscroll containment are the sheet's.
      style={{ maxBlockSize: RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX }}
    >
      {/* Two boxes rather than absolute positioning, so the rendered rows stay in
          the document's own flow: the content box holds the whole list's height so
          the scrollbar reports the whole enumeration, and the window is placed at
          the offset of its first row. */}
      <div style={{ blockSize: virtualizer.getTotalSize() }}>
        <ul
          // The modifier drops the gap and the leading padding — space the window
          // arithmetic does not account for — in the sheet, beside the rules it
          // overrides. Only the offset is inline, because only the offset is computed.
          className="meridian-restore-disclosure__paths meridian-restore-disclosure__paths--windowed"
          style={{ transform: `translateY(${String(virtualRows[0]?.start ?? 0)}px)` }}
        >
          {virtualRows.map((virtualRow) => {
            const path = props.paths[virtualRow.index];
            return path === undefined ? null : (
              // The window holds a slice, so each row says where it sits in the
              // whole enumeration; without it a screen reader would be told the
              // list is as long as the window. The row primitive writes that pair
              // and the index attribute the virtualizer measures against, so the
              // changed-file list and this one cannot come to disagree about
              // whether a position is counted from zero or one.
              <WindowedListRow
                as="li"
                key={virtualRow.key}
                rowIndex={virtualRow.index}
                totalRowCount={props.paths.length}
                rowRef={virtualizer.measureElement}
              >
                <RestorePathCell path={path} onOpenPath={props.onOpenPath} />
              </WindowedListRow>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
