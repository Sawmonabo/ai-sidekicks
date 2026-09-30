// A combobox's portal, positioner and popup, registered in the window's airspace as a
// `popover` (the overlay kinds have no combobox entry). `Combobox.Root` stays with the caller,
// which owns the items, value and filter.

import { Combobox } from "@base-ui/react/combobox";

import { useAirspaceRegistration } from "@renderer/hooks/useAirspaceRegistration.js";

/** What the popup renders, and the class names the caller styles it with. */
export interface OverlayComboboxPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName: string;
  readonly className: string;
  readonly children: React.ReactNode;
}

/** A combobox's portal, positioner and popup, registered as a popover in the airspace. */
export function OverlayComboboxPopup(props: OverlayComboboxPopupProps): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration("popover");
  return (
    <Combobox.Portal container={props.container}>
      <Combobox.Positioner className={props.positionerClassName}>
        <Combobox.Popup ref={airspaceRef} className={props.className}>
          {props.children}
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}
