// The pane's tab strip: one tab per page the session owns.
//
// Each tab carries the page's label where the agent set one and its title otherwise,
// and a close control. The strip draws a reading and decides nothing: which tab is
// current and whether a page is loading are read off the frame. It is present only at
// two or more pages: with one page or none there is nothing to choose between, and a
// list nobody has reported is never shown as a session with no pages.
//
// NO TAB SEMANTICS, DELIBERATELY. `role="tablist"` promises a `tabpanel` for each tab,
// and there is no panel here: the page is painted by a native view over the pane's
// rectangle and is not in this document at all. So the strip is a list of controls,
// the current one is marked `aria-current`, and a screen reader is told the truth
// about what it is looking at rather than a shape it can navigate into and find
// nothing behind.

import "./PageTabStrip.css";

import { useState } from "react";

import type { PreviewPage } from "@ai-sidekicks/contracts";

import { Glyph } from "@renderer/console/primitives/index.js";
import { activePageOf, pagesOf, type PageListReading } from "../page-list-reading.js";
import {
  isTabDrag,
  pageMoveIndex,
  readTabDragPayload,
  writeTabDragPayload,
} from "../tab-reorder.js";

/** The page reading a strip draws and the acts its controls dispatch. */
export interface PageTabStripProps {
  readonly reading: PageListReading;
  readonly onSelect: (pageId: string) => void;
  readonly onClose: (pageId: string) => void;
  /** `toIndex` addresses the list WITHOUT the moved page. See `tab-reorder.ts`. */
  readonly onReorder: (pageId: string, toIndex: number) => void;
}

/** One tab per open page, with drag reordering; draws nothing below two pages. */
export function PageTabStrip(props: PageTabStripProps): React.JSX.Element | null {
  const { reading, onSelect, onClose, onReorder } = props;
  // The drop position a drag is currently over, held only while a drag is in the air. It is
  // renderer-local by nature — nothing outside this window knows a pointer is down —
  // and it is `undefined` between drags rather than a stale number, so the drop
  // indicator cannot be left painted after a drag that ended somewhere else.
  const [hoveredDropPosition, setHoveredDropPosition] = useState<number | undefined>(undefined);
  const pages = pagesOf(reading);
  const activePageId = activePageOf(reading)?.pageId;

  const dropAt = (dropPosition: number, transfer: DataTransfer): void => {
    setHoveredDropPosition(undefined);
    const pageId = readTabDragPayload(transfer);
    if (pageId === undefined) {
      return;
    }
    const fromIndex = pages.findIndex((page) => page.pageId === pageId);
    if (fromIndex < 0) {
      return;
    }
    // THE ONE CALL SITE. The drop position is a position among the tabs as drawn and the
    // registry's index addresses the list without the moved page; `pageMoveIndex` is
    // where that difference is spent, and it is spent here and nowhere else.
    const toIndex = pageMoveIndex(fromIndex, dropPosition);
    if (toIndex === undefined) {
      return;
    }
    onReorder(pageId, toIndex);
  };

  if (pages.length < 2) {
    return null;
  }

  return (
    <div className="meridian-preview-tabs">
      <ul className="meridian-preview-tabs__list">
        {pages.map((page, index) => (
          <li
            key={page.pageId}
            className={tabClassName(page.pageId === activePageId, hoveredDropPosition === index)}
            draggable
            onDragStart={(event) => {
              writeTabDragPayload(event.dataTransfer, page.pageId);
            }}
            onDragEnd={() => {
              setHoveredDropPosition(undefined);
            }}
            onDragOver={(event) => {
              if (!isTabDrag(event.dataTransfer)) {
                return;
              }
              // Preventing the default is what makes this element a drop target at
              // all; without it the drop never fires and the tab springs back.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setHoveredDropPosition(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              dropAt(index, event.dataTransfer);
            }}
          >
            <button
              type="button"
              className="meridian-preview-tab__face"
              aria-current={page.pageId === activePageId ? "page" : undefined}
              onClick={() => {
                onSelect(page.pageId);
              }}
            >
              {page.isLoading ? (
                <>
                  <span className="meridian-preview-tab__spinner" aria-hidden="true" />
                  <span className="meridian-visually-hidden">Loading</span>
                </>
              ) : null}
              <span className="meridian-preview-tab__label">{tabLabel(page)}</span>
            </button>
            <button
              type="button"
              className="meridian-preview-tab__close"
              aria-label={`Close ${tabLabel(page)}`}
              onClick={() => {
                onClose(page.pageId);
              }}
            >
              <Glyph name="close" size={11} />
            </button>
          </li>
        ))}
        {/* The trailing drop position. There are `n + 1` places a tab can land among `n`
            tabs, and without this one the last position is unreachable by drag. */}
        <li
          className={
            hoveredDropPosition === pages.length
              ? "meridian-preview-tabs__tail meridian-preview-tab--drop-before"
              : "meridian-preview-tabs__tail"
          }
          onDragOver={(event) => {
            if (!isTabDrag(event.dataTransfer)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setHoveredDropPosition(pages.length);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dropAt(pages.length, event.dataTransfer);
          }}
        />
      </ul>
    </div>
  );
}

/**
 * The tab's classes: the base, the selected mark, and the drop marker.
 *
 * THE SELECTED MARK IS A CLASS AND NOT AN ATTRIBUTE SELECTOR. `aria-current` belongs
 * on the interactive element, which is the face inside the item — so a rule keyed on
 * the ITEM's `aria-current` matches nothing and the selected tab is drawn exactly like
 * every other one. That is invisible in every unit case, because no cascade runs
 * there; the browser tier is where it is caught, and this is the shape that keeps the
 * accessible marker and the styling hook from having to be the same thing.
 */
function tabClassName(isSelected: boolean, isDropTarget: boolean): string {
  return [
    "meridian-preview-tab",
    isSelected ? "meridian-preview-tab--selected" : undefined,
    isDropTarget ? "meridian-preview-tab--drop-before" : undefined,
  ]
    .filter((token) => token !== undefined)
    .join(" ");
}

/** What a tab shows when the agent set no label: the page's own title, then its host. */
function tabLabel(page: PreviewPage): string {
  if (page.label !== null && page.label.length > 0) {
    return page.label;
  }
  return page.title.length > 0 ? page.title : page.host;
}
