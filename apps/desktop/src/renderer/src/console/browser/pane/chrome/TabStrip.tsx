// The pane's tab strip: one tab per page the session owns, and the context chip that
// heads them.
//
// `Spec-023 §Console Design (Meridian)` 12.2 Renders, first bullet. Four things are
// on the row and each is the design's own: the leading chip carrying the browsing
// context name the agent set, one tab per page carrying its label where the agent set
// one and its title otherwise, a close control on each, and a create control.
//
// IT DRAWS A READING AND DECIDES NOTHING. Which tab is current, whether a page is
// loading, and whether the list is even known are all read off `page-state.ts`'s
// frame. The empty arm is the design's — "the strip collapses to the context chip and
// a create control" — and it is reachable only from a SERVED reading, because a strip
// that has not been answered yet is not a session with no pages. That is rule 8, and
// it is the whole reason this component takes the reading rather than the array.
//
// NO TAB SEMANTICS, DELIBERATELY. `role="tablist"` promises a `tabpanel` for each tab,
// and there is no panel here: the page is painted by a native view over the pane's
// rectangle and is not in this document at all. So the strip is a list of controls,
// the current one is marked `aria-current`, and a screen reader is told the truth
// about what it is looking at rather than a shape it can navigate into and find
// nothing behind.

import { useState } from "react";

import { Glyph, InlineRefusal, Nothing } from "../../../primitives/index.js";
import { BrowsingContextChip } from "./BrowsingContextChip.js";
import { ChromeControl } from "./ChromeControl.js";
import { pagesOf, type BrowserPage, type PageListReading } from "../page-state.js";
import {
  isTabDrag,
  pageMoveIndex,
  readTabDragPayload,
  writeTabDragPayload,
} from "./tab-reorder.js";

export interface TabStripProps {
  readonly reading: PageListReading;
  readonly onSelect: (pageId: string) => void;
  readonly onClose: (pageId: string) => void;
  readonly onCreate: () => void;
  /** `toIndex` addresses the list WITHOUT the moved page. See `tab-reorder.ts`. */
  readonly onReorder: (pageId: string, toIndex: number) => void;
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
    "meridian-browser-tab",
    isSelected ? "meridian-browser-tab--selected" : undefined,
    isDropTarget ? "meridian-browser-tab--drop-before" : undefined,
  ]
    .filter((token) => token !== undefined)
    .join(" ");
}

/** What a tab shows when the agent set no label: the page's own title, then its host. */
function tabLabel(page: BrowserPage): string {
  if (page.label !== null && page.label.length > 0) {
    return page.label;
  }
  return page.title.length > 0 ? page.title : page.host;
}

export function TabStrip(props: TabStripProps): React.JSX.Element {
  const { reading, onSelect, onClose, onCreate, onReorder } = props;
  // The slot a drag is currently over, held only while a drag is in the air. It is
  // renderer-local by nature — nothing outside this window knows a pointer is down —
  // and it is `undefined` between drags rather than a stale number, so the drop
  // indicator cannot be left painted after a drag that ended somewhere else.
  const [hoveredSlot, setHoveredSlot] = useState<number | undefined>(undefined);
  const pages = pagesOf(reading);

  const dropAt = (slot: number, transfer: DataTransfer): void => {
    setHoveredSlot(undefined);
    const pageId = readTabDragPayload(transfer);
    if (pageId === undefined) {
      return;
    }
    const fromIndex = pages.findIndex((page) => page.pageId === pageId);
    if (fromIndex < 0) {
      return;
    }
    // THE ONE CALL SITE. The drop slot is a position among the tabs as drawn and the
    // registry's index addresses the list without the moved page; `pageMoveIndex` is
    // where that difference is spent, and it is spent here and nowhere else.
    const toIndex = pageMoveIndex(fromIndex, slot);
    if (toIndex === undefined) {
      return;
    }
    onReorder(pageId, toIndex);
  };

  return (
    <div className="meridian-browser-tabs">
      <BrowsingContextChip reading={reading} />
      {reading.kind === "refused" ? (
        <InlineRefusal {...reading.refusal} />
      ) : reading.kind === "reading" ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Pages not read"
          detail="No answer has come back about which pages this session owns. Nothing here says this session owns no pages."
        />
      ) : reading.kind === "ended" ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Pages no longer reported"
          detail="The producer that listed this session's pages finished. Nothing here says the pages closed."
        />
      ) : pages.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="No pages open"
          detail="This session owns no pages. Create one to start."
        />
      ) : (
        <ul className="meridian-browser-tabs__list">
          {pages.map((page, index) => (
            <li
              key={page.pageId}
              className={tabClassName(page.isSelected, hoveredSlot === index)}
              draggable
              onDragStart={(event) => {
                writeTabDragPayload(event.dataTransfer, page.pageId);
              }}
              onDragEnd={() => {
                setHoveredSlot(undefined);
              }}
              onDragOver={(event) => {
                if (!isTabDrag(event.dataTransfer)) {
                  return;
                }
                // Preventing the default is what makes this element a drop target at
                // all; without it the drop never fires and the tab springs back.
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setHoveredSlot(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropAt(index, event.dataTransfer);
              }}
            >
              <button
                type="button"
                className="meridian-browser-tab__face"
                aria-current={page.isSelected ? "page" : undefined}
                onClick={() => {
                  onSelect(page.pageId);
                }}
              >
                {page.isLoading ? (
                  <>
                    <span className="meridian-browser-tab__spinner" aria-hidden="true" />
                    <span className="meridian-visually-hidden">Loading</span>
                  </>
                ) : null}
                <span className="meridian-browser-tab__label">{tabLabel(page)}</span>
                {page.isShown ? null : (
                  <span className="meridian-browser-tab__background">background</span>
                )}
              </button>
              <button
                type="button"
                className="meridian-browser-tab__close"
                aria-label={`Close ${tabLabel(page)}`}
                onClick={() => {
                  onClose(page.pageId);
                }}
              >
                <Glyph name="close" size={11} />
              </button>
            </li>
          ))}
          {/* The trailing slot. There are `n + 1` places a tab can land among `n`
            tabs, and without this one the last position is unreachable by drag. */}
          <li
            className={
              hoveredSlot === pages.length
                ? "meridian-browser-tabs__tail meridian-browser-tab--drop-before"
                : "meridian-browser-tabs__tail"
            }
            onDragOver={(event) => {
              if (!isTabDrag(event.dataTransfer)) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setHoveredSlot(pages.length);
            }}
            onDrop={(event) => {
              event.preventDefault();
              dropAt(pages.length, event.dataTransfer);
            }}
          />
        </ul>
      )}
      <ChromeControl label="New page" glyph="plus" onActivate={onCreate} />
    </div>
  );
}
