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
// WHICH MEANS THE KEYBOARD IS THIS FILE'S PROBLEM. A window mounts the rows a scroll
// position needs, so tabbing can only ever reach those — and a file list a keyboard
// cannot leave the top of is a file list half the operators cannot use. The list is
// therefore one tab stop with arrow keys inside it, which is the composite-widget
// pattern: one entry is tabbable, the arrows move which, and moving asks the window
// for that row and focuses it once it mounts.
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

import { DerivedFigure, Glyph } from "../../primitives/index.js";
import { DIFF_FILE_LIST_SCROLL_THRESHOLD, DIFF_FILE_ROW_HEIGHT_PX } from "./diff-bounds.js";
import {
  HIDDEN_SELECTION_COPY,
  diffFileListReading,
  selectedEntryRow,
  type DiffFileListEntry,
} from "./diff-file-entries.js";
import type { ConsoleDiffModel } from "./diff-model.js";
import { useRowWindow, type RowWindow } from "./row-window.js";

export interface DiffFileListProps {
  readonly diff: ConsoleDiffModel;
  /** The path whose rows are shown, or `undefined` for the whole change set. */
  readonly selectedFilePath: string | undefined;
  readonly onSelectFilePath: (path: string | undefined) => void;
}

/** Glyph edge length in a file row, matching the primitives' own inline size. */
const DIFF_FILE_GLYPH_SIZE = 12;

/** The attribute a row carries its index on, so focus can find the row it moved to. */
const ENTRY_INDEX_ATTRIBUTE = "data-entry-index";

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
  const { activeIndex, onKeyDown } = useRovingEntryFocus({
    entryWindow,
    entryCount: entries.length,
    selectedIndex: openingIndex,
    scrollerRef,
  });

  // The selection is the narrowing, and a narrowing whose row is off-window is a
  // control a reader cannot see the state of. Asked for on every change rather than
  // only on mount, because the filter can move a selected file's index under it.
  useEffect(() => {
    entryWindow.scrollToIndex(openingIndex);
  }, [entryWindow, openingIndex]);

  const isScrolling = props.diff.files.length > DIFF_FILE_LIST_SCROLL_THRESHOLD;
  const virtualRows = entryWindow.getVirtualItems();

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
              <li
                key={entry.kind === "all-files" ? "all-files" : `file:${entry.path}`}
                className="meridian-diff-files__row"
                data-index={virtualRow.index}
                style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
              >
                <DiffFileEntryButton
                  entry={entry}
                  entryIndex={virtualRow.index}
                  isSelected={virtualRow.index === currentIndex}
                  isTabbable={virtualRow.index === activeIndex}
                  onSelectFilePath={props.onSelectFilePath}
                />
              </li>
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
  readonly entryIndex: number;
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
      {...{ [ENTRY_INDEX_ATTRIBUTE]: props.entryIndex }}
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

/** How far one key moves the active row, or `undefined` where it moves nothing. */
const ENTRY_MOVE_BY_KEY: Readonly<Record<string, "next" | "previous" | "first" | "last">> = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Home: "first",
  End: "last",
};

/**
 * One tab stop, arrow keys inside it, and the moved-to row focused once it mounts.
 *
 * THE TWO HALVES ARE SEPARATE BECAUSE THE ROW MAY NOT EXIST YET. Moving asks the
 * window for a row that a window bounded by the viewport has very likely not mounted,
 * so the key handler records where focus is going and the effect below takes it there
 * on whichever render the row arrives on — which is why the rendered window is one of
 * its dependencies rather than only the index.
 *
 * FOCUS IS ONLY EVER TAKEN, NEVER GIVEN BACK. The effect moves focus for a key the
 * list itself handled, so it cannot steal focus from elsewhere on the page: nothing
 * sets the pending flag but the handler, and the handler runs only on a key delivered
 * to this list.
 */
function useRovingEntryFocus(options: {
  readonly entryWindow: RowWindow;
  readonly entryCount: number;
  readonly selectedIndex: number;
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>;
}): {
  readonly activeIndex: number;
  readonly onKeyDown: (keyEvent: React.KeyboardEvent<HTMLUListElement>) => void;
} {
  const { entryWindow, entryCount, selectedIndex, scrollerRef } = options;
  const [movedToIndex, setMovedToIndex] = useState<number | undefined>(undefined);
  const pendingFocus = useRef(false);

  // The selection is where the keyboard starts, so a list reopened on a file puts its
  // one tab stop on that file rather than at the top. A move supersedes it, and a
  // move past the end of a filtered list falls back to the selection the same way.
  const activeIndex = Math.min(movedToIndex ?? selectedIndex, Math.max(entryCount - 1, 0));

  const virtualRows = entryWindow.getVirtualItems();
  useEffect(() => {
    if (!pendingFocus.current) {
      return;
    }
    const row = scrollerRef.current?.querySelector<HTMLButtonElement>(
      `[${ENTRY_INDEX_ATTRIBUTE}="${String(activeIndex)}"]`,
    );
    if (row === null || row === undefined) {
      return;
    }
    pendingFocus.current = false;
    row.focus();
  }, [activeIndex, scrollerRef, virtualRows]);

  const onKeyDown = useCallback(
    (keyEvent: React.KeyboardEvent<HTMLUListElement>) => {
      const move = ENTRY_MOVE_BY_KEY[keyEvent.key];
      if (move === undefined || entryCount === 0) {
        return;
      }
      keyEvent.preventDefault();
      const moved = movedEntryIndex(move, activeIndex, entryCount);
      pendingFocus.current = true;
      setMovedToIndex(moved);
      entryWindow.scrollToIndex(moved);
    },
    [activeIndex, entryCount, entryWindow],
  );

  return { activeIndex, onKeyDown };
}

/** Where one move lands. Clamped rather than wrapped: a list has two ends. */
function movedEntryIndex(
  move: "next" | "previous" | "first" | "last",
  activeIndex: number,
  entryCount: number,
): number {
  switch (move) {
    case "next":
      return Math.min(activeIndex + 1, entryCount - 1);
    case "previous":
      return Math.max(activeIndex - 1, 0);
    case "first":
      return 0;
    case "last":
      return entryCount - 1;
  }
}
