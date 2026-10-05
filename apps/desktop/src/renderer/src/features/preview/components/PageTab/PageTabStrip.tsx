// The pane's tab strip: one tab per page, with the page's icon, its title (the host until the
// title arrives) and a close control. It draws a reading and shows only at two or more pages.
// Not `role="tablist"`: there is no `tabpanel`, since a native view paints the page over the
// pane's rectangle, so the strip is a list of controls and the current one is `aria-current`.

import "./PageTabStrip.css";

import { useMemo } from "react";

import type { PreviewPage, PreviewPageId } from "@ai-sidekicks/contracts/preview/preview";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { useReorderDrag } from "#renderer/hooks/useReorderDrag.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { PageTabIcon } from "./PageTabIcon.js";
import { activePageOf, pagesOf, type PageListReading } from "../../page-list-reading.js";

/** The page reading a strip draws and the acts its controls dispatch. */
export interface PageTabStripProps {
  readonly reading: PageListReading;
  readonly onSelect: (pageId: PreviewPageId) => void;
  readonly onClose: (pageId: PreviewPageId) => void;
  /**
   * Moves a page to `toIndex` in the list without it; called once per drag, on release. The tab
   * is drawn in its new place until the reading's page order changes.
   */
  readonly onReorder: (pageId: PreviewPageId, toIndex: number) => void;
}

/** One tab per open page, reordered by dragging a tab; draws nothing below two pages. */
export function PageTabStrip(props: PageTabStripProps): React.JSX.Element | null {
  const { reading, onSelect, onClose, onReorder } = props;
  const pages = pagesOf(reading);
  const activePageId = activePageOf(reading)?.pageId;
  const pageIds = useMemo(() => pages.map((page) => page.pageId), [pages]);
  const tabDrag = useReorderDrag("horizontal", pageIds, onReorder);

  if (pages.length < 2) {
    return null;
  }

  return (
    <div className="meridian-preview-tabs">
      <ul className="meridian-preview-tabs__list">
        {pages.map((page) => (
          <li
            key={page.pageId}
            ref={tabDrag.itemRef(page.pageId)}
            className={
              page.pageId === activePageId
                ? "meridian-preview-tab meridian-preview-tab--selected"
                : "meridian-preview-tab"
            }
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
      </ul>
    </div>
  );
}

/** What a tab shows: the page's own title, then its host until the title arrives. */
function tabLabel(page: PreviewPage): string {
  return page.title.length > 0 ? page.title : page.host;
}
