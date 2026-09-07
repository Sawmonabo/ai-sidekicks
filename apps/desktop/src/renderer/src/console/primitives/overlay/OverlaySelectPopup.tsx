// A select's portal, positioner, and popup — registered in the window's airspace.
//
// `Select.Root`, its trigger, and its value stay with the caller: they are the
// control, and they render where they stand. The list is anchored and floating, which
// is the part a native view would paint over and the part that belongs here.
//
// THE KIND IS `popover`, on `OverlayComboboxPopup`'s reasoning — 12.3 enumerates what
// a thing IS on screen, and an anchored floating list is a popover whichever widget
// family opened it.

import { Select } from "@base-ui/react/select";

import { useAirspaceRegistration } from "../airspace-registration.js";

export interface OverlaySelectPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName?: string | undefined;
  readonly className: string;
  readonly children: React.ReactNode;
}

export function OverlaySelectPopup(props: OverlaySelectPopupProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("popover");
  return (
    <Select.Portal container={props.container}>
      <Select.Positioner className={props.positionerClassName}>
        <Select.Popup ref={airspaceRef} className={props.className}>
          {props.children}
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  );
}
