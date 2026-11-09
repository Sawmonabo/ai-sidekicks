// A strip tab's menu, opened at a right-click, the keyboard's menu key or Shift+F10 on the tab: the
// pane's own rows, then four rows that move the tab within the strip as a drag does. A row with
// nothing to do is disabled, and says why in its hover label where the pane gave a reason.

import { Menu } from "@base-ui/react/menu";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { OverlayMenuPopup } from "#renderer/components/OverlayPopups/OverlayMenuPopup.js";

/** One of the pane's own rows: its words, what pressing it does, and why it cannot, if it cannot. */
export interface TabMenuRow {
  readonly label: string;
  readonly onPress: () => void;
  /** Set while the row has nothing to act on: it is drawn disabled with these words. */
  readonly disabledReason?: string | undefined;
}

/** Which tab the menu is open for, and what it is placed against. */
export interface TabMenuTarget<Key extends string> {
  readonly key: Key;
  /** The tab itself, or the point a right-click landed on. */
  readonly anchor: NonNullable<Menu.Positioner.Props["anchor"]>;
}

/** What a strip tab's menu draws from and does. */
export interface TabMenuProps<Key extends string> {
  /** The tab the menu is open for, or `undefined` while it is closed. */
  readonly target: TabMenuTarget<Key> | undefined;
  /** The strip's tabs in their order. */
  readonly keys: readonly Key[];
  readonly rows: readonly TabMenuRow[];
  /** Told as one of the pane's own rows is pressed, before its act runs. */
  readonly onRowPressed: () => void;
  /** Moves a tab to `toIndex` in the list without it, as a drag's release does. */
  readonly onMove: (key: Key, toIndex: number) => void;
  readonly onDismiss: () => void;
}

/** The menu of the tab `target` names, drawn only while it is open. */
export function TabMenu<Key extends string>(props: TabMenuProps<Key>): React.JSX.Element {
  const { target, keys, rows, onRowPressed, onMove, onDismiss } = props;
  const index = target === undefined ? -1 : keys.indexOf(target.key);
  return (
    <Menu.Root
      open={target !== undefined && index >= 0}
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <OverlayMenuPopup anchor={target?.anchor} className="meridian-tab-menu">
        {rows.map((row) => (
          <HoverLabel key={row.label} text={row.disabledReason ?? ""} textRole="description">
            <Menu.Item
              className="meridian-tab-menu__row"
              disabled={row.disabledReason !== undefined}
              onClick={() => {
                onRowPressed();
                row.onPress();
              }}
            >
              {row.label}
            </Menu.Item>
          </HoverLabel>
        ))}
        {rows.length === 0 ? null : <Menu.Separator className="meridian-tab-menu__separator" />}
        {MOVE_ROWS.map((row) => {
          const destination = row.destinationOf(index, keys.length);
          return (
            <Menu.Item
              key={row.label}
              className="meridian-tab-menu__row"
              disabled={destination === undefined}
              onClick={() => {
                if (target !== undefined && destination !== undefined) {
                  onMove(target.key, destination);
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

/** One move row: its words, and where it moves a tab at `index` of `count`, if anywhere. */
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
