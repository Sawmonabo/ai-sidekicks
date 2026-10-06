// The pane's tab strip: one tab per page, with the page's icon, its title (the host until the
// title arrives) and a close control. It draws a reading and shows only at two or more pages.
// Not `role="tablist"`: there is no `tabpanel`, since a native view paints the page over the
// pane's rectangle, so the strip is a list of controls and the current one is `aria-current`.
// A middle-click on a tab closes it exactly as its close control does, and nothing says so. A
// tab's menu, at a right-click, the menu key or Shift+F10, moves it as a drag does and says
// where it landed; the strip mints no chord of its own.

import "./PageTabStrip.css";

import { useMemo, useState } from "react";

import type { PreviewPage, PreviewPageId } from "@ai-sidekicks/contracts/preview/methods";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useReorderDrag } from "#renderer/hooks/useReorderDrag.js";
import { type Refusal } from "#renderer/lib/refusal/refusal.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { PageTabIcon } from "./PageTabIcon.js";
import { PageTabMenu, type PageTabMenuTarget } from "./PageTabMenu.js";
import { activePageOf, pagesOf, type PageListReading } from "../../page-list-reading.js";

/** The page reading a strip draws and the acts its controls dispatch. */
export interface PageTabStripProps {
  readonly reading: PageListReading;
  readonly onSelect: (pageId: PreviewPageId) => void;
  readonly onClose: (pageId: PreviewPageId) => void;
  /**
   * Moves a page to `toIndex` in the list without it; called once per drag, on release, and once
   * per move from a tab's menu. Answers the refusal when the move was refused, and a dragged tab
   * glides back to where it was; a served move leaves the tab drawn in its new place until the
   * reading's page order changes.
   */
  readonly onReorder: (pageId: PreviewPageId, toIndex: number) => Promise<Refusal | undefined>;
}

/**
 * One tab per open page, reordered by dragging a tab or from its menu; draws nothing below two
 * pages. Mounted under the window's live announcer, which every committed move speaks through.
 */
export function PageTabStrip(props: PageTabStripProps): React.JSX.Element | null {
  const { reading, onSelect, onClose, onReorder } = props;
  const pages = pagesOf(reading);
  const activePageId = activePageOf(reading)?.pageId;
  const pageIds = useMemo(() => pages.map((page) => page.pageId), [pages]);
  const clock = useClock();
  const announce = useAnnounce();
  const [menuTarget, setMenuTarget] = useState<PageTabMenuTarget | undefined>(undefined);
  // The one commit a drop and a menu row make: the live region names where the tab landed, or
  // reads the refusal's own sentence. A canceled drag commits nothing, so it says nothing.
  const commitMove = async (
    pageId: PreviewPageId,
    toIndex: number,
  ): Promise<Refusal | undefined> => {
    const page = pages.find((candidate) => candidate.pageId === pageId);
    const refusal = await onReorder(pageId, toIndex);
    if (refusal !== undefined) {
      announce(refusal.detail, "assertive");
      return refusal;
    }
    announce(
      `Moved ${page === undefined ? "the tab" : tabLabel(page)} to position ` +
        `${String(toIndex + 1)} of ${String(pages.length)}.`,
      "polite",
    );
    return undefined;
  };
  const tabDrag = useReorderDrag(
    "horizontal",
    pageIds,
    (pageId, toIndex) => {
      // A refused move brings no new order to settle on, so the tabs are put back here.
      void commitMove(pageId, toIndex).then(
        (refusal) => {
          if (refusal !== undefined) {
            tabDrag.settle();
          }
        },
        (failure: unknown) => {
          tabDrag.settle();
          throw failure;
        },
      );
    },
    clock,
  );

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
            onMouseDown={(event) => {
              // The middle button's own press would start the platform's autoscroll.
              if (event.button === MIDDLE_BUTTON) {
                event.preventDefault();
              }
            }}
            onAuxClick={(event) => {
              if (event.button === MIDDLE_BUTTON) {
                event.preventDefault();
                onClose(page.pageId);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              // A right-click opens the menu at the pointer; a keyboard's opens it at the tab.
              const tab = event.currentTarget;
              const pointX = event.clientX;
              const pointY = event.clientY;
              setMenuTarget({
                pageId: page.pageId,
                anchor:
                  event.button === SECONDARY_BUTTON
                    ? { getBoundingClientRect: () => DOMRect.fromRect({ x: pointX, y: pointY }) }
                    : tab,
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                event.preventDefault();
                setMenuTarget({ pageId: page.pageId, anchor: event.currentTarget });
              }
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
      </ul>
      <PageTabMenu
        target={menuTarget}
        pageIds={pageIds}
        onMove={(pageId, toIndex) => {
          void commitMove(pageId, toIndex);
        }}
        onDismiss={() => {
          setMenuTarget(undefined);
        }}
      />
    </div>
  );
}

/** The middle button's number in `MouseEvent.button`. */
const MIDDLE_BUTTON = 1;

/** The secondary button's number in `MouseEvent.button`: a right-click. */
const SECONDARY_BUTTON = 2;

/** What a tab shows: the page's own title, then its host until the title arrives. */
function tabLabel(page: PreviewPage): string {
  return page.title.length > 0 ? page.title : page.host;
}
