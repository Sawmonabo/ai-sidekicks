// The page list: all ten pages, always, in order, with one tab stop and the arrows inside it.
//
// Side by side the cursor opens the page it lands on, so an arrow, Home or End draws that page at
// once, and it wraps at both ends in the order the list draws. While the list stands alone on a
// narrow window a move only moves the cursor: opening the page there would replace the list the
// cursor is in, so Enter and Space open it. The tab stop rests on the open page, or the one last
// open.
// Under search hits the list stays drawn but collapsed and inert, so the page names still size
// the list's track.

import { useCallback, useRef } from "react";

import { WindowedListRow } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { useWindowedRovingIndex } from "#renderer/hooks/useWindowedRovingIndex.js";
import { SETTINGS_PAGE_IDS, type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "../pages/labels.js";

/** Props for {@link SettingsPageList}. */
export interface SettingsPageListProps {
  readonly currentPageId: SettingsPageId | undefined;
  /** Where the tab stop rests: the open page, or the one last open. */
  readonly restingPageId: SettingsPageId | undefined;
  /** A person's open: a press, Enter or Space. */
  readonly onOpenPage: (pageId: SettingsPageId) => void;
  /** Opens the page a cursor move lands on; `undefined` while a move only moves the cursor. */
  readonly onCursorMove: ((pageId: SettingsPageId) => void) | undefined;
  /** Whether search hits stand in for the list, which then keeps only its width. */
  readonly isCollapsed: boolean;
}

/** Every page, always: the list is the closed set of pages and never a filtered view of it. */
export function SettingsPageList(props: SettingsPageListProps): React.JSX.Element {
  const { currentPageId, restingPageId, onOpenPage, onCursorMove, isCollapsed } = props;
  const listRef = useRef<HTMLUListElement | null>(null);
  const followCursorAt = useCallback(
    (rowIndex: number): void => {
      const pageId = SETTINGS_PAGE_IDS[rowIndex];
      if (pageId !== undefined) {
        onCursorMove?.(pageId);
      }
    },
    [onCursorMove],
  );
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: SETTINGS_PAGE_IDS.length,
    anchorIndex: restingPageId === undefined ? 0 : SETTINGS_PAGE_IDS.indexOf(restingPageId),
    containerRef: listRef,
    wrapsAround: true,
    ...(onCursorMove === undefined ? {} : { onRowMove: followCursorAt }),
    // Every row is always drawn, so the window never changes.
    windowRevision: SETTINGS_PAGE_IDS,
  });

  return (
    <nav
      aria-label="Settings pages"
      className="meridian-settings__page-nav"
      data-collapsed={isCollapsed ? "" : undefined}
      inert={isCollapsed}
    >
      <ul ref={listRef} className="meridian-settings__page-list" onKeyDown={onKeyDown}>
        {SETTINGS_PAGE_IDS.map((pageId, rowIndex) => (
          <WindowedListRow
            key={pageId}
            as="li"
            rowIndex={rowIndex}
            totalRowCount={SETTINGS_PAGE_IDS.length}
            isTabbable={rowIndex === activeIndex}
          >
            {(targetProps) => (
              <button
                type="button"
                className="meridian-settings__page-entry"
                aria-current={pageId === currentPageId ? "page" : undefined}
                onClick={() => {
                  onOpenPage(pageId);
                }}
                {...targetProps}
              >
                {SETTINGS_PAGE_LABELS[pageId]}
              </button>
            )}
          </WindowedListRow>
        ))}
      </ul>
    </nav>
  );
}
