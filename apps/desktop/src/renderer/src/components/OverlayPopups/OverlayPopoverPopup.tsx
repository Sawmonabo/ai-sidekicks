// A popover's portal, positioner and popup, registered in the window's airspace. `Popover.Root`,
// the trigger, the offset and the popup's `id` stay with the caller (a trigger names the popup
// through `aria-controls`).

import { Popover } from "@base-ui/react/popover";

import { useAirspaceRegistration } from "@renderer/hooks/useAirspaceRegistration.js";

/** Props for `OverlayPopoverPopup`. */
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

/**
 * Anchored portal, positioner and popup for a popover.
 *
 * @consumedBy a popover that must register its airspace over a native view
 */
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
