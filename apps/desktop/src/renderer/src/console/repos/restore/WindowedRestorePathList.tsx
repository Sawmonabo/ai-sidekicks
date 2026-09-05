import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef } from "react";
import { RESTORE_PATH_ROW_HEIGHT_PX } from "../../core/index.js";
import { WindowedListRow, useWindowedRovingIndex } from "../../primitives/index.js";

import { RestorePathCell } from "./RestorePathCell.js";
import {
  type RestorePathListProps,
  RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX,
} from "./restore-path-window.js";

/**
 * The same paths, with only the window's worth of rows in the document.
 *
 * A WINDOW MOUNTS A SLICE, SO ITS TAB STOPS WERE A MOVING NUMBER. Every drawn row here
 * carries a control where the mounting surface can open a diff, and each of those is a
 * tab stop — so scrolling this region changed how many stops the page's tab order held,
 * and a reader tabbing past a four-thousand-path enumeration walked whatever slice
 * happened to be mounted. `useWindowedRovingIndex` is the console's one answer: ONE
 * entry is tabbable, the arrow keys move which, and the moved-to row is focused on
 * whichever render the window mounts it on.
 *
 * THE STOP IS ON THE CONTROL AND THE REGION KEEPS ITS OWN ONLY WHERE THERE IS NONE.
 * `RestorePathCell` renders plain text when the surface has no diff to open, and a
 * scroll region with no control in it still has to be reachable — that is what the
 * container's own `tabIndex` was always for. So the two are exclusive rather than
 * stacked: with controls the roving stop is inside the rows and the container takes
 * none, without them the container keeps the one stop it had. Keeping both would put a
 * stop on the region AND a stop inside it, which is two stops for one enumeration.
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
  const revealIndex = useCallback(
    (rowIndex: number) => {
      virtualizer.scrollToIndex(rowIndex);
    },
    [virtualizer],
  );
  // The drawn sequence is the move's identity: a disclosure re-read with a different
  // change set draws different paths, and an index into a sequence that no longer
  // exists addresses a different path, or none.
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: props.paths.length,
    anchorIndex: 0,
    containerRef: scrollerRef,
    revealIndex,
    rowSetIdentity: props.paths,
    windowRevision: virtualRows,
  });
  // The rows carry a control exactly when the mounting surface can open one, which is
  // the same condition that decides where this enumeration's one tab stop lives.
  const rowsCarryAControl = props.onOpenPath !== undefined;
  return (
    <div
      className="meridian-restore-disclosure__path-scroller"
      ref={scrollerRef}
      role="group"
      aria-label={props.label}
      tabIndex={rowsCarryAControl ? undefined : 0}
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
          onKeyDown={rowsCarryAControl ? onKeyDown : undefined}
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
              // THE ROW DELEGATES ITS STOP TO THE CELL'S CONTROL, and only where there
              // is one: `isTabbable` is the row's claim to hold the enumeration's one
              // stop, and a list of plain text has no control to put it on — the
              // scroller keeps its own, which is the exclusivity stated above. The
              // renderer form is what makes the marked element and the focusable
              // element one element; marking the `<li>` while the stop sat on the
              // button left the roving effect focusing something Chromium will not
              // focus.
              <WindowedListRow
                as="li"
                key={virtualRow.key}
                rowIndex={virtualRow.index}
                totalRowCount={props.paths.length}
                rowRef={virtualizer.measureElement}
                {...(rowsCarryAControl ? { isTabbable: virtualRow.index === activeIndex } : {})}
              >
                {(targetProps) => (
                  <RestorePathCell
                    path={path}
                    onOpenPath={props.onOpenPath}
                    {...(rowsCarryAControl ? { targetProps } : {})}
                  />
                )}
              </WindowedListRow>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
