// The pane's tab strip: one tab per page, with the page's icon, its title (the host until the
// title arrives) and a close control. It draws a reading and shows only at two or more pages.
// Not `role="tablist"`: there is no `tabpanel`, since a native view paints the page over the
// pane's rectangle, so the strip is a list of controls and the current one is `aria-current`.

import "./PageTabStrip.css";

import { useState } from "react";

import type { PreviewPage, PreviewPageId } from "@ai-sidekicks/contracts/preview";

import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_ROW } from "@renderer/styles/glyphs.js";
import { PageTabIcon } from "./PageTabIcon.js";
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
  readonly onSelect: (pageId: PreviewPageId) => void;
  readonly onClose: (pageId: PreviewPageId) => void;
  /** `toIndex` addresses the list without the moved page. See `tab-reorder.ts`. */
  readonly onReorder: (pageId: PreviewPageId, toIndex: number) => void;
}

/** One tab per open page, with drag reordering; draws nothing below two pages. */
export function PageTabStrip(props: PageTabStripProps): React.JSX.Element | null {
  const { reading, onSelect, onClose, onReorder } = props;
  // The drop position a drag is over, held only during a drag and `undefined` between drags, so
  // the indicator cannot stay painted after a drag that ended elsewhere.
  const [hoveredDropPosition, setHoveredDropPosition] = useState<number | undefined>(undefined);
  const pages = pagesOf(reading);
  const activePageId = activePageOf(reading)?.pageId;

  const dropAt = (dropPosition: number, transfer: DataTransfer): void => {
    setHoveredDropPosition(undefined);
    const draggedPageId = readTabDragPayload(transfer);
    if (draggedPageId === undefined) {
      return;
    }
    const fromIndex = pages.findIndex((page) => page.pageId === draggedPageId);
    const dragged = pages[fromIndex];
    if (dragged === undefined) {
      return;
    }
    // The drop position counts tabs as drawn; the registry's index excludes the moved page.
    // `pageMoveIndex` is the one place that difference is spent.
    const toIndex = pageMoveIndex(fromIndex, dropPosition);
    if (toIndex === undefined) {
      return;
    }
    onReorder(dragged.pageId, toIndex);
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
              // Preventing the default makes this element a drop target; without it no drop fires.
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
              <PageTabIcon page={page} />
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
              <Glyph name="close" size={GLYPH_SIZE_ROW} />
            </button>
          </li>
        ))}
        {/* The trailing drop position: without it the last of the `n + 1` places is
            unreachable by drag. */}
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
 * The tab's classes: the base, the selected mark, and the drop marker. The selected mark is a
 * class because `aria-current` sits on the face inside the item, so a rule keyed on the item's
 * `aria-current` would match nothing.
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

/** What a tab shows: the page's own title, then its host until the title arrives. */
function tabLabel(page: PreviewPage): string {
  return page.title.length > 0 ? page.title : page.host;
}
