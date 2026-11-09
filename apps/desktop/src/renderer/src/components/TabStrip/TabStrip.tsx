// The tab strip Preview's pages and the terminal's shells share, drawn once so both panes read as
// one shape: one tab per item, its leading mark, its label and its `×`, the shown one marked
// current, and whatever the pane puts at the strip's end. Not `role="tablist"`: neither pane draws
// a `tabpanel` (Preview's page is a native view painted over the pane), so the strip is a list of
// controls and the current one is `aria-current`.
//
// A middle-click on a tab closes it exactly as its `×` does, and nothing says so. A tab drags to
// reorder, and its menu, at a right-click, the menu key or Shift+F10, holds the pane's own rows
// and the moves a drag makes; every committed move says where the tab landed. The strip mints no
// chord of its own. Closing a tab from the strip hands focus to the tab left shown once it goes.

import "./TabStrip.css";

import { useMemo, useRef, useState } from "react";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { useReorderDrag } from "#renderer/hooks/useReorderDrag.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { useFocusAfterClose } from "./hooks/useFocusAfterClose.js";
import { TabMenu, type TabMenuRow, type TabMenuTarget } from "./TabMenu.js";

/** One tab: the key its acts name, the words it shows, and what is drawn before them. */
export interface StripTab<Key extends string> {
  readonly key: Key;
  readonly label: string;
  /** Drawn before the label, inside the tab's face: a page's icon, a shell's mark. */
  readonly leading?: React.ReactNode;
  /** Whether what the tab holds has ended, which draws its words faint. */
  readonly isEnded?: boolean;
}

/** The tabs a strip draws, the shown one, and the acts its controls dispatch. */
export interface TabStripProps<Key extends string> {
  readonly tabs: readonly StripTab<Key>[];
  /** The tab shown, `undefined` while none is. */
  readonly activeKey: Key | undefined;
  /** The window's clock, from `useClock()`; a drag's edge scroll runs on its frames. */
  readonly clock: Clock;
  readonly onSelect: (key: Key) => void;
  readonly onClose: (key: Key) => void;
  /**
   * Moves a tab to `toIndex` in the list without it; called once per drag, on release, and once
   * per move from a tab's menu. Answers the refusal when the move was refused, and a dragged tab
   * glides back to where it was; a served move leaves the tab drawn in its new place until the
   * tabs' order changes.
   */
  readonly onReorder: (key: Key, toIndex: number) => Promise<Refusal | undefined>;
  /** The pane's own rows a tab's menu holds above its moves. */
  readonly menuRowsOf?: ((key: Key) => readonly TabMenuRow[]) | undefined;
  /** Drawn after the tabs, at the strip's end. */
  readonly trailing?: React.ReactNode;
}

/**
 * One tab per item, reordered by dragging a tab or from its menu. Mounted under the window's live
 * announcer, which every committed move speaks through.
 */
export function TabStrip<Key extends string>(props: TabStripProps<Key>): React.JSX.Element {
  const { tabs, activeKey, clock, onSelect, onClose, onReorder, menuRowsOf } = props;
  const keys = useMemo(() => tabs.map((tab) => tab.key), [tabs]);
  const announce = useAnnounce();
  const stripScrollbarRef = useDrawOverlayScrollbar<HTMLDivElement>();
  const [menuTarget, setMenuTarget] = useState<TabMenuTarget<Key> | undefined>(undefined);
  const faces = useRef(new Map<Key, HTMLButtonElement>());
  const focusAfterClose = useFocusAfterClose(keys, activeKey, faces.current);

  const closeTab = (key: Key): void => {
    focusAfterClose.expect();
    onClose(key);
  };
  // The one commit a drop and a menu row make: the live region names where the tab landed, or
  // reads the refusal's own sentence. A canceled drag commits nothing, so it says nothing.
  const commitMove = async (key: Key, toIndex: number): Promise<Refusal | undefined> => {
    const tab = tabs.find((candidate) => candidate.key === key);
    const refusal = await onReorder(key, toIndex);
    if (refusal !== undefined) {
      announce(refusal.detail, "assertive");
      return refusal;
    }
    announce(
      `Moved ${tab === undefined ? "the tab" : tab.label} to position ` +
        `${String(toIndex + 1)} of ${String(tabs.length)}.`,
      "polite",
    );
    return undefined;
  };
  const tabDrag = useReorderDrag(
    "horizontal",
    keys,
    (key, toIndex) => {
      // A refused move brings no new order to settle on, so the tabs are put back here.
      void commitMove(key, toIndex).then(
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

  return (
    <div className="meridian-tab-strip" ref={stripScrollbarRef}>
      <ul className="meridian-tab-strip__list">
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            <li
              key={tab.key}
              ref={tabDrag.itemRef(tab.key)}
              className={tabClassName(isActive, tab.isEnded === true)}
              onMouseDown={(event) => {
                // The middle button's own press would start the platform's autoscroll.
                if (event.button === MIDDLE_BUTTON) {
                  event.preventDefault();
                }
              }}
              onAuxClick={(event) => {
                if (event.button === MIDDLE_BUTTON) {
                  event.preventDefault();
                  closeTab(tab.key);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                // A right-click opens the menu at the pointer; a keyboard's opens it at the tab.
                const tabElement = event.currentTarget;
                const pointX = event.clientX;
                const pointY = event.clientY;
                setMenuTarget({
                  key: tab.key,
                  anchor:
                    event.button === SECONDARY_BUTTON
                      ? { getBoundingClientRect: () => DOMRect.fromRect({ x: pointX, y: pointY }) }
                      : tabElement,
                });
              }}
              onKeyDown={(event) => {
                if (opensTabMenu(event)) {
                  event.preventDefault();
                  setMenuTarget({ key: tab.key, anchor: event.currentTarget });
                }
              }}
            >
              <button
                type="button"
                className="meridian-tab__face"
                ref={(face) => {
                  if (face === null) {
                    faces.current.delete(tab.key);
                  } else {
                    faces.current.set(tab.key, face);
                  }
                }}
                aria-current={isActive ? "true" : undefined}
                onClick={() => {
                  onSelect(tab.key);
                }}
              >
                {tab.leading}
                <span className="meridian-tab__label">{tab.label}</span>
              </button>
              <button
                type="button"
                className="meridian-tab__close"
                aria-label={`Close ${tab.label}`}
                onClick={() => {
                  closeTab(tab.key);
                }}
              >
                <Glyph name="close" size={GLYPH_SIZE_ROW} />
              </button>
            </li>
          );
        })}
      </ul>
      {props.trailing}
      <TabMenu
        target={menuTarget}
        keys={keys}
        rows={menuTarget === undefined ? [] : (menuRowsOf?.(menuTarget.key) ?? [])}
        onRowPressed={focusAfterClose.expect}
        onMove={(key, toIndex) => {
          void commitMove(key, toIndex);
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

function tabClassName(isActive: boolean, isEnded: boolean): string {
  return [
    "meridian-tab",
    isActive ? "meridian-tab--selected" : undefined,
    isEnded ? "meridian-tab--ended" : undefined,
  ]
    .filter((name) => name !== undefined)
    .join(" ");
}

// Exactly the menu key alone or Shift+F10: a further modifier makes it another chord, which the
// strip leaves to whatever holds it.
function opensTabMenu(event: React.KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  return event.shiftKey ? event.key === "F10" : event.key === "ContextMenu";
}
