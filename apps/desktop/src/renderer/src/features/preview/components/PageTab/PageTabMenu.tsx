// A page tab's menu, opened at a right-click, the keyboard's menu key or Shift+F10 on the tab:
// four rows that move the tab within the strip. A row with nowhere to move the tab is disabled.

import { Menu } from "@base-ui/react/menu";

import type { PreviewPageId } from "@ai-sidekicks/contracts/preview/methods";

import { OverlayMenuPopup } from "#renderer/components/OverlayPopups/OverlayMenuPopup.js";

/** Which tab the menu is open for, and what it is placed against. */
export interface PageTabMenuTarget {
  readonly pageId: PreviewPageId;
  /** The tab itself, or the point a right-click landed on. */
  readonly anchor: NonNullable<Menu.Positioner.Props["anchor"]>;
}

/** What a page tab's menu draws from and does. */
export interface PageTabMenuProps {
  /** The tab the menu is open for, or `undefined` while it is closed. */
  readonly target: PageTabMenuTarget | undefined;
  /** The strip's pages in their order. */
  readonly pageIds: readonly PreviewPageId[];
  /** Moves a page to `toIndex` in the list without it, as a drag's release does. */
  readonly onMove: (pageId: PreviewPageId, toIndex: number) => void;
  readonly onDismiss: () => void;
}

/** One row: its words, and where it moves a tab at `index` of `count`, if anywhere. */
interface MoveRow {
  readonly label: string;
  readonly destinationOf: (index: number, count: number) => number | undefined;
}

const MOVE_ROWS: readonly MoveRow[] = [
  { label: "Move left", destinationOf: (index) => (index > 0 ? index - 1 : undefined) },
  {
    label: "Move right",
    destinationOf: (index, count) => (index < count - 1 ? index + 1 : undefined),
  },
  { label: "Move to start", destinationOf: (index) => (index > 0 ? 0 : undefined) },
  {
    label: "Move to end",
    destinationOf: (index, count) => (index < count - 1 ? count - 1 : undefined),
  },
];

/** The menu of the tab `target` names, drawn only while it is open. */
export function PageTabMenu(props: PageTabMenuProps): React.JSX.Element {
  const { target, pageIds, onMove, onDismiss } = props;
  const index = target === undefined ? -1 : pageIds.indexOf(target.pageId);
  return (
    <Menu.Root
      open={target !== undefined && index >= 0}
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <OverlayMenuPopup
        anchor={target?.anchor}
        positionerClassName="meridian-preview-tab-menu__positioner"
        className="meridian-preview-tab-menu"
      >
        {MOVE_ROWS.map((row) => {
          const destination = row.destinationOf(index, pageIds.length);
          return (
            <Menu.Item
              key={row.label}
              className="meridian-preview-tab-menu__row"
              disabled={destination === undefined}
              onClick={() => {
                if (target !== undefined && destination !== undefined) {
                  onMove(target.pageId, destination);
                }
              }}
            >
              {row.label}
            </Menu.Item>
          );
        })}
      </OverlayMenuPopup>
    </Menu.Root>
  );
}
