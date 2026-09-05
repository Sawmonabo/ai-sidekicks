import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { GLYPH_SIZE_ROW } from "../../tokens/index.js";
import { Glyph, WindowedListRow, useWindowedRovingIndex } from "../../primitives/index.js";
import { DIFF_FILE_LIST_SCROLL_THRESHOLD, DIFF_FILE_ROW_HEIGHT_PX } from "./diff-bounds.js";
import {
  HIDDEN_SELECTION_COPY,
  diffFileListReading,
  selectedEntryRow,
} from "./diff-file-entries.js";
import type { ConsoleDiffModel } from "./diff-model.js";
import { useRowWindow } from "./row-window.js";
import { DiffFileEntryButton } from "./DiffFileEntryButton.js";

export interface DiffFileListProps {
  readonly diff: ConsoleDiffModel;
  /** The path whose rows are shown, or `undefined` for the whole change set. */
  readonly selectedFilePath: string | undefined;
  readonly onSelectFilePath: (path: string | undefined) => void;
}

export function DiffFileList(props: DiffFileListProps): React.JSX.Element {
  const filterId = useId();
  const [filterText, setFilterText] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const { entries, matchCount } = useMemo(
    () => diffFileListReading(props.diff, filterText),
    [props.diff, filterText],
  );
  const selectedRow = selectedEntryRow(entries, props.selectedFilePath);
  // The row `aria-current` goes on, and `undefined` where the narrowing has none: a
  // hidden selection marks nothing rather than marking the reset control, which would
  // say the list is showing every file while the renderer shows one.
  const currentIndex = selectedRow.kind === "row" ? selectedRow.index : undefined;
  // Where the window opens and where the keyboard starts. Row zero for a hidden
  // selection, which is the only row a filter that hides the narrowing always draws.
  const openingIndex = currentIndex ?? 0;

  const entryWindow = useRowWindow({
    rowCount: entries.length,
    getScrollElement: () => scrollerRef.current,
    estimatedRowHeightPx: DIFF_FILE_ROW_HEIGHT_PX,
    // Where the list OPENS. A first paint happens before anything can scroll, so a
    // pane reopened on a selection a thousand rows down would otherwise open at the
    // top with the selected row unmounted; the effect below carries every later move.
    initialOffsetPx: openingIndex * DIFF_FILE_ROW_HEIGHT_PX,
  });
  const revealIndex = useCallback(
    (rowIndex: number) => {
      entryWindow.scrollToIndex(rowIndex);
    },
    [entryWindow],
  );
  const virtualRows = entryWindow.getVirtualItems();
  // One tab stop, arrow keys inside it, and the moved-to row focused once the window
  // mounts it. The drawn sequence is the move's identity: the filter can shrink the
  // set under a move and grow it back, and an index into a sequence that no longer
  // exists addresses a different file, or none.
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: entries.length,
    anchorIndex: openingIndex,
    containerRef: scrollerRef,
    revealIndex,
    rowSetIdentity: entries,
    windowRevision: virtualRows,
  });

  // The selection is the narrowing, and a narrowing whose row is off-window is a
  // control a reader cannot see the state of. Asked for on every change rather than
  // only on mount, because the filter can move a selected file's index under it.
  useEffect(() => {
    entryWindow.scrollToIndex(openingIndex);
  }, [entryWindow, openingIndex]);

  const isScrolling = props.diff.files.length > DIFF_FILE_LIST_SCROLL_THRESHOLD;

  return (
    <div className={`meridian-diff-files${isScrolling ? " meridian-diff-files--scrolling" : ""}`}>
      <label className="meridian-diff-files__filter" htmlFor={filterId}>
        <Glyph name="search" size={GLYPH_SIZE_ROW} />
        <span className="meridian-visually-hidden">Filter changed files</span>
        <input
          id={filterId}
          type="search"
          className="meridian-diff-files__filter-input"
          placeholder="Filter files"
          value={filterText}
          onChange={(changeEvent) => {
            setFilterText(changeEvent.target.value);
          }}
        />
      </label>
      <div className="meridian-diff-files__scroller" ref={scrollerRef}>
        {/* The list holds the whole height so the scrollbar reports every entry, and
            each rendered row is placed at its own offset. The row height has ONE
            home, `diff-bounds.ts`, and the sheet reads it from here. */}
        <ul
          className="meridian-diff-files__list"
          style={
            {
              blockSize: entryWindow.getTotalSize(),
              "--meridian-diff-file-row-height": `${String(DIFF_FILE_ROW_HEIGHT_PX)}px`,
            } as React.CSSProperties
          }
          onKeyDown={onKeyDown}
        >
          {virtualRows.map((virtualRow) => {
            const entry = entries[virtualRow.index];
            return entry === undefined ? null : (
              // The window mounts a slice, so each row says how long the list is and
              // where in it this row sits — without which a reader is told the change
              // set is as long as the window happens to be. The primitive writes that
              // pair and the index the roving move is resolved against.
              //
              // THE TAB STOP IS THE BUTTON INSIDE, NOT THE ROW — a row is a list item
              // and the control is what activates a file, so a stop on the `<li>`
              // would answer Enter with nothing. The row is TOLD which row is active
              // and DELEGATES the stop through the renderer form, so the element the
              // roving effect focuses and the element that holds `tabindex` are one
              // element. Passing the flag to the button instead left the row marking
              // itself as the focus target while the stop sat on the button, and
              // `focus()` on an `<li>` with no `tabindex` is a no-op in Chromium.
              <WindowedListRow
                as="li"
                key={entry.kind === "all-files" ? "all-files" : `file:${entry.path}`}
                className="meridian-diff-files__row"
                rowIndex={virtualRow.index}
                totalRowCount={entries.length}
                isTabbable={virtualRow.index === activeIndex}
                style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
              >
                {(targetProps) => (
                  <DiffFileEntryButton
                    entry={entry}
                    isSelected={virtualRow.index === currentIndex}
                    onSelectFilePath={props.onSelectFilePath}
                    {...targetProps}
                  />
                )}
              </WindowedListRow>
            );
          })}
        </ul>
      </div>
      {matchCount === 0 ? (
        <p className="meridian-diff-files__no-match">No changed file matches that filter.</p>
      ) : null}
      {selectedRow.kind === "hidden-by-filter" ? (
        // Said out loud rather than left to an absent highlight: the rows on the right
        // are still the narrowed file's, and a list with nothing current and no line
        // explaining it reads as a list that lost the selection.
        <p className="meridian-diff-files__hidden-selection">{HIDDEN_SELECTION_COPY}</p>
      ) : null}
    </div>
  );
}
