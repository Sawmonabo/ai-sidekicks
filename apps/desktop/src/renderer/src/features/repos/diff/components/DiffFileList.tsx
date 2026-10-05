import { useId, useMemo, useRef } from "react";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { WindowedListRow } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { useRowWindow } from "#renderer/hooks/useRowWindow.js";
import { useWindowedRovingIndex } from "#renderer/hooks/useWindowedRovingIndex.js";
import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import {
  DIFF_FILE_ROW_HEIGHT_PX,
  DIFF_VIEWPORT_FALLBACK_HEIGHT_PX,
  DIFF_WINDOW_OVERSCAN_ROWS,
} from "../measures.js";
import { DIFF_FILE_LIST_SCROLL_THRESHOLD } from "../caps.js";
import { HIDDEN_SELECTION_COPY, diffFileListReading, selectedEntryRow } from "../file-entries.js";
import type { DiffModel } from "../diff-model.js";
import { DiffFileEntryButton } from "./DiffFileEntryButton.js";

/** What the changed-file list is drawn from. */
export interface DiffFileListProps {
  readonly diff: DiffModel;
  /** The path whose rows are shown, or `undefined` for the whole change set. */
  readonly selectedFilePath: string | undefined;
  readonly onSelectFilePath: (path: string | undefined) => void;
}

/** The filter and windowed list of a change set's changed files, with the reset row first. */
export function DiffFileList(props: DiffFileListProps): React.JSX.Element {
  const filterId = useId();
  // Scoped to the model like the selection and gap expansion: a filter typed against one
  // change set means nothing for another, and the list is not remounted on a re-point.
  const { value: filterText, publish: publishFilterText } = useSubjectScopedState<string>(
    props.diff,
    undefined,
    () => "",
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const clock = useBridgeClock();

  const { entries, matchCount } = useMemo(
    () => diffFileListReading(props.diff, filterText),
    [props.diff, filterText],
  );
  const selectedRow = selectedEntryRow(entries, props.selectedFilePath);
  // The row `aria-current` goes on. A selection hidden by the filter marks nothing, not the
  // reset control, which would say every file is shown while the renderer shows one.
  const currentIndex = selectedRow.kind === "row" ? selectedRow.index : undefined;
  // Where the window opens and the keyboard starts. Row zero is the one row a filter that
  // hides the selection always draws.
  const openingIndex = currentIndex ?? 0;

  const { virtualizer: entryWindow, revealRow } = useRowWindow({
    rowCount: entries.length,
    getScrollElement: () => scrollerRef.current,
    clock,
    estimateRowHeightPx: () => DIFF_FILE_ROW_HEIGHT_PX,
    overscanRows: DIFF_WINDOW_OVERSCAN_ROWS,
    initialViewportHeightPx: DIFF_VIEWPORT_FALLBACK_HEIGHT_PX,
    // Where the list opens: first paint precedes any scroll, so a reopened deep selection would
    // start unmounted at the top. The roving index reveals every later move of the anchor.
    initialOffsetPx: openingIndex * DIFF_FILE_ROW_HEIGHT_PX,
  });
  const virtualRows = entryWindow.getVirtualItems();
  // One tab stop with arrow keys inside it. The drawn sequence is the move's identity: the
  // filter can shrink the set under a move, and a stale index addresses another file or none.
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: entries.length,
    anchorIndex: openingIndex,
    containerRef: scrollerRef,
    revealIndex: revealRow,
    rowSetIdentity: entries,
    windowRevision: virtualRows,
  });

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
            publishFilterText(changeEvent.target.value);
          }}
        />
      </label>
      <div className="meridian-diff-files__scroller" ref={scrollerRef}>
        {/* The list holds the whole height so the scrollbar spans every entry; each row sits at
            its own offset. Row height lives in `measures.ts`, and the sheet reads it. */}
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
              // Each row says how long the list is and where it sits, since the window mounts
              // only a slice. The tab stop is the button inside, not the `<li>`: the row is
              // told which row is active and delegates the stop through the renderer form, as
              // `focus()` on an `<li>` without `tabindex` is a no-op in Chromium.
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
        // Said aloud: the rows shown are still the narrowed file's, and a list with nothing
        // current reads as if it lost the selection.
        <p className="meridian-diff-files__hidden-selection">{HIDDEN_SELECTION_COPY}</p>
      ) : null}
    </div>
  );
}
