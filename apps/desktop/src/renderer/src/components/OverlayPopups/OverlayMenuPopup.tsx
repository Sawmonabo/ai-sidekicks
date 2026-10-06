// A menu's portal, positioner and popup, registered in the window's airspace. `Menu.Root`, the
// trigger, the items and the offset stay with the caller; a menu opened with no trigger, as a
// right-click's is, names its anchor.

import { Menu } from "@base-ui/react/menu";

import { useAirspaceRegistration } from "#renderer/hooks/useAirspaceRegistration.js";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";
import { overlayClassName } from "./overlay-class-name.js";

/** Props for `OverlayMenuPopup`. */
export interface OverlayMenuPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` is its own window's body. */
  readonly container?: HTMLElement | null | undefined;
  /** Distance from the anchor, in pixels, as the positioner takes it. */
  readonly sideOffset?: number | undefined;
  /** What the popup is placed against; absent, the menu's own trigger. */
  readonly anchor?: Menu.Positioner.Props["anchor"];
  readonly className: string;
  readonly children: React.ReactNode;
}

/** Anchored portal, positioner and popup for a menu. */
export function OverlayMenuPopup(props: OverlayMenuPopupProps): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const airspaceRef = useAirspaceRegistration();
  return (
    <Menu.Portal container={props.container ?? ownerWindow.document.body}>
      <Menu.Positioner
        className={overlayClassName(undefined)}
        sideOffset={props.sideOffset}
        anchor={props.anchor}
      >
        <Menu.Popup ref={airspaceRef} className={overlayClassName(props.className)}>
          {props.children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}
