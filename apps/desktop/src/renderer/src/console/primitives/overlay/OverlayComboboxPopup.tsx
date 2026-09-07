// A combobox's portal, positioner, and popup — registered in the window's airspace.
//
// `Combobox.Root` stays with the caller, and deliberately: the root is where the
// items, the value, and the filter live, and it is also what a surface composes a
// dialog inside (the command palette does exactly that). Only the anchored part of
// the tree crosses into the primitive layer.
//
// THE KIND IS `popover`. 12.3's enumeration has no combobox entry and does not need
// one — what a native view has to yield to is a floating box anchored to a control,
// which is what the enumeration calls a popover.

import { Combobox } from "@base-ui/react/combobox";

import { useAirspaceRegistration } from "../airspace-registration.js";

export interface OverlayComboboxPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` falls back to `<body>`. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName: string;
  readonly className: string;
  readonly children: React.ReactNode;
}

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
