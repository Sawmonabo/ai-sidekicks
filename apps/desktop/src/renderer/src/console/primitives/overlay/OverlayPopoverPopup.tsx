// A popover's portal, positioner, and popup — registered in the window's airspace.
//
// `Popover.Root` and the trigger stay with the caller, and so does the render prop a
// handle-driven root takes: which payload is open is the surface's state, and this
// wrapper renders whatever that surface put inside it. What crosses into here is the
// anchored part of the tree, which is the part a native view would paint over.
//
// THE OFFSET AND THE POSITIONER'S CLASS ARE THE CALLER'S, on `OverlayMenuPopup`'s
// reason: how far a popover sits from the control that opened it is a layout decision
// the surface makes beside its own chrome, and a primitive that fixed it would be
// deciding for every popover the console ever grows.
//
// THE POPUP'S `id` IS THE CALLER'S TOO, because it is half of a relationship the
// caller owns the other half of: a marker naming its popup through `aria-controls`
// mints one id and spends it in two places, and a primitive that minted one instead
// would leave that marker pointing at nothing.

import { Popover } from "@base-ui/react/popover";

import { useAirspaceRegistration } from "../airspace-registration.js";

export interface OverlayPopoverPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName?: string | undefined;
  /** Distance from the anchor, in pixels, as the positioner takes it. */
  readonly sideOffset?: number | undefined;
  /** The popup's own id, where a trigger names it. */
  readonly popupId?: string | undefined;
  readonly className: string;
  readonly children: React.ReactNode;
}

export function OverlayPopoverPopup(props: OverlayPopoverPopupProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("popover");
  return (
    <Popover.Portal container={props.container}>
      <Popover.Positioner className={props.positionerClassName} sideOffset={props.sideOffset}>
        <Popover.Popup ref={airspaceRef} id={props.popupId} className={props.className}>
          {props.children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
