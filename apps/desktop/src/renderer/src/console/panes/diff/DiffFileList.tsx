// The changed-file list, its filter, and the window it is drawn through.
//
// A FILE LIST WITH A FILTER, and `DiffPane.tsx`'s density opens the pane on it. So
// the list is the pane's first surface rather than a sidebar bolted beside it,
// and selecting a file narrows the rows to that file — which is what makes a
// forty-file change set navigable without a second scroller to lose your place
// in.
//
// AND IT IS WINDOWED, THROUGH THE SAME PRIMITIVE THE ROWS ARE. Past its threshold
// this list used to add a scrolling class and mount every matching file anyway, so a
// generated or repository-wide patch cost thousands of buttons before the already
// virtualized body could help, and every keystroke in the filter rebuilt all of them.
// `row-window.ts` is the one place `@tanstack/react-virtual` is configured for this
// family, so the two scrollers share their overscan band, their pre-measurement
// viewport, and their refusal to flush synchronously.
//
// THE ROWS STAY AN `<li>` OF A REAL `<ul>`, which is why they are PLACED rather than
// spaced: the rows renderer puts its window behind a leading spacer because its rows
// are generic boxes carrying table roles, and this list's semantics are the element's
// own. An absolutely placed `<li>` is still a list item in the accessibility tree; a
// `<div>` between a `<ul>` and its items is not.
//
// WHICH MEANS THE KEYBOARD IS A WINDOWED LIST'S PROBLEM, AND IT IS SOLVED ONCE. A
// window mounts the rows a scroll position needs, so tabbing can only ever reach
// those — and a file list a keyboard cannot leave the top of is a file list half the
// operators cannot use. The list is therefore one tab stop with arrow keys inside it,
// which is the composite-widget pattern; `useWindowedRovingIndex` is where that
// pattern lives, so this file says which sequence a move belongs to and nothing else.
//
// THE COUNTS ARE DERIVED FIGURES, NOT WIRE FIGURES. `+12 −3` is the console's own
// arithmetic over the model, so it renders through `DerivedFigure` and never
// through `WireFigure` — the provenance signature rule (`Spec-023` rule 4) is
// about where a number came from, and these came from here.
//
// AND THE COUNTS ARE NOT THE WHOLE CHANGE. A rename, a copy, a mode change, and a
// binary change all live in a git patch's extended headers, so a file whose change is
// only one of those has no hunks and counts `+0 −0` — which, alone, reads as nothing
// having happened to it. The note beside the counts is what the patch actually said,
// composed once by `diff-model.ts` so this list and the row renderer cannot disagree
// about it. The counts stay: they are true, and suppressing them would make an
// extended-header file the one row a reader cannot compare with its neighbours.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  DerivedFigure,
  Glyph,
  WindowedListRow,
  useWindowedRovingIndex,
} from "../../primitives/index.js";
import { DIFF_FILE_LIST_SCROLL_THRESHOLD, DIFF_FILE_ROW_HEIGHT_PX } from "./diff-bounds.js";
import {
  HIDDEN_SELECTION_COPY,
  diffFileListReading,
  selectedEntryRow,
  type DiffFileListEntry,
} from "./diff-file-entries.js";
import type { ConsoleDiffModel } from "./diff-model.js";
import { useRowWindow } from "./row-window.js";

export interface DiffFileListProps {
  readonly diff: ConsoleDiffModel;
  /** The path whose rows are shown, or `undefined` for the whole change set. */
  readonly selectedFilePath: string | undefined;
  readonly onSelectFilePath: (path: string | undefined) => void;
}

/** Glyph edge length in a file row, matching the primitives' own inline size. */
const DIFF_FILE_GLYPH_SIZE = 12;

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
        <Glyph name="search" size={DIFF_FILE_GLYPH_SIZE} />
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
              // THE TAB STOP IS THE BUTTON INSIDE, NOT THE ROW, so `isTabbable` is
              // withheld here on purpose: a row is a list item and the control is
              // what activates a file, and a stop on the `<li>` would answer Enter
              // with nothing. The roving index focuses the focusable inside the row
              // it moved to, which is that button.
              <WindowedListRow
                as="li"
                key={entry.kind === "all-files" ? "all-files" : `file:${entry.path}`}
                className="meridian-diff-files__row"
                rowIndex={virtualRow.index}
                totalRowCount={entries.length}
                style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
              >
                <DiffFileEntryButton
                  entry={entry}
                  isSelected={virtualRow.index === currentIndex}
                  isTabbable={virtualRow.index === activeIndex}
                  onSelectFilePath={props.onSelectFilePath}
                />
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

/** One row's control: the reset at row zero, or one changed file. */
function DiffFileEntryButton(props: {
  readonly entry: DiffFileListEntry;
  readonly isSelected: boolean;
  readonly isTabbable: boolean;
  readonly onSelectFilePath: (path: string | undefined) => void;
}): React.JSX.Element {
  const { entry } = props;
  const selectedPath = entry.kind === "all-files" ? undefined : entry.path;
  return (
    <button
      type="button"
      className="meridian-diff-files__entry"
      aria-current={props.isSelected}
      // ONE TAB STOP FOR THE WHOLE LIST, which is what makes the arrows necessary and
      // what stops a windowed list from putting a moving number of stops in the page's
      // tab order.
      tabIndex={props.isTabbable ? 0 : -1}
      onClick={() => {
        props.onSelectFilePath(selectedPath);
      }}
    >
      {entry.kind === "all-files" ? (
        <>
          <span className="meridian-diff-files__path">All files</span>
          <DerivedFigure text={String(entry.fileCount)} />
        </>
      ) : (
        <>
          {/* Wire-verbatim path, truncated at the measure with the full string
              recoverable through the title — the pane subject's own rule. */}
          <span className="meridian-diff-files__path" title={entry.path}>
            {entry.path}
          </span>
          {entry.changeNotes.length === 0 ? null : (
            <span className="meridian-diff-files__change" title={entry.changeNotes.join(", ")}>
              {entry.changeNotes.join(", ")}
            </span>
          )}
          <span className="meridian-diff-files__counts">
            <DerivedFigure text={`+${String(entry.counts.insertions)}`} />
            <DerivedFigure text={`−${String(entry.counts.deletions)}`} />
          </span>
        </>
      )}
    </button>
  );
}
