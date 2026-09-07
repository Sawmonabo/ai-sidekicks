// A menu's portal, positioner, and popup — registered in the window's airspace.
//
// `Menu.Root` and `Menu.Trigger` stay with the caller: a menu is opened by its own
// trigger and the items are the surface's vocabulary. What crosses into here is the
// anchored part of the tree, which is the part a native view would paint over.
//
// THE OFFSET IS THE CALLER'S. How far a menu sits from the control that opened it is
// a layout decision the surface makes beside its own chrome, and a primitive that
// fixed it would be deciding for every menu the console ever grows.

import { Menu } from "@base-ui/react/menu";

import { useAirspaceRegistration } from "../airspace-registration.js";

export interface OverlayMenuPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName: string;
  /** Distance from the anchor, in pixels, as the positioner takes it. */
  readonly sideOffset?: number | undefined;
  readonly className: string;
  readonly children: React.ReactNode;
}

export function OverlayMenuPopup(props: OverlayMenuPopupProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("context-menu");
  return (
    <Menu.Portal container={props.container}>
      <Menu.Positioner className={props.positionerClassName} sideOffset={props.sideOffset}>
        <Menu.Popup ref={airspaceRef} className={props.className}>
          {props.children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}
