// A menu's portal, positioner and popup, registered in the window's airspace. `Menu.Root`, the
// trigger, the items and the offset stay with the caller.

import { Menu } from "@base-ui/react/menu";

import { useAirspaceRegistration } from "@renderer/hooks/useAirspaceRegistration.js";

/** Props for `OverlayMenuPopup`. */
export interface OverlayMenuPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName: string;
  /** Distance from the anchor, in pixels, as the positioner takes it. */
  readonly sideOffset?: number | undefined;
  readonly className: string;
  readonly children: React.ReactNode;
}

/** Anchored portal, positioner and popup for a menu. */
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
