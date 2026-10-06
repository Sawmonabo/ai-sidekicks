// A select's portal, positioner and popup, registered in the window's airspace. `Select.Root`, its
// trigger and its value stay with the caller. The airspace kind is `popover`: an anchored floating
// list is a popover whichever widget opened it.

import { Select } from "@base-ui/react/select";

import { useAirspaceRegistration } from "#renderer/hooks/useAirspaceRegistration.js";
import { useOwnerWindow } from "#renderer/hooks/owner-window/useOwnerWindow.js";
import { overlayClassName } from "#renderer/components/OverlayPopups/overlay-class-name.js";

/** The classes and children of the popup, and where it portals. */
export interface OverlaySelectPopupProps {
  /** Where the popup portals. The frame's overlay root; `undefined` is its own window's body. */
  readonly container?: HTMLElement | null | undefined;
  readonly positionerClassName?: string | undefined;
  readonly className: string;
  readonly children: React.ReactNode;
}

/** The floating list of a select, anchored by its positioner and registered as a popover. */
export function OverlaySelectPopup(props: OverlaySelectPopupProps): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const airspaceRef = useAirspaceRegistration();
  return (
    <Select.Portal container={props.container ?? ownerWindow.document.body}>
      <Select.Positioner className={overlayClassName(props.positionerClassName)}>
        <Select.Popup ref={airspaceRef} className={overlayClassName(props.className)}>
          {props.children}
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  );
}
