// A tooltip's portal, positioner, and popup — registered in the window's airspace.
//
// `Tooltip.Root`, its provider, and the triggers stay with the caller: which control
// is holding the tooltip open and what it is about are the surface's, and a bar that
// drives one popup from many triggers keeps that arrangement to itself. What crosses
// into here is the anchored part of the tree.
//
// THE KIND IS `popover`, on `OverlayComboboxPopup`'s reasoning — 12.3 enumerates what
// a thing IS on screen and has no tooltip entry, and an anchored floating box is a
// popover whichever widget family opened it. A native view has to yield to it either
// way, which is the only question the enumeration is asked.

import { Tooltip } from "@base-ui/react/tooltip";

import { useAirspaceRegistration } from "../airspace-registration.js";

export interface OverlayTooltipPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName?: string | undefined;
  /** Distance from the anchor, in pixels, as the positioner takes it. */
  readonly sideOffset?: number | undefined;
  readonly className: string;
  readonly children: React.ReactNode;
}

export function OverlayTooltipPopup(props: OverlayTooltipPopupProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("popover");
  return (
    <Tooltip.Portal container={props.container}>
      <Tooltip.Positioner className={props.positionerClassName} sideOffset={props.sideOffset}>
        <Tooltip.Popup ref={airspaceRef} className={props.className}>
          {props.children}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}
