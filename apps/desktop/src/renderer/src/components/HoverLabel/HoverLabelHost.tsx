// The one hover label a window draws, for whichever trigger `HoverLabel` marked that the pointer or
// the keyboard is on. Base UI's tooltip places it against that trigger, flips it where its side
// has no room, and closes it on Escape or a press anywhere; which trigger it belongs to is read
// from the document. The label sits flush against its trigger, its gap drawn inside its own
// transparent edge, so the pointer crosses straight from the trigger onto it without closing it.

import { useRef } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

import { overlayClassName } from "#renderer/components/OverlayPopups/overlay-class-name.js";
import { useAirspaceRegistration } from "#renderer/hooks/useAirspaceRegistration.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useShownHoverLabel } from "./hooks/useShownHoverLabel.js";

import "./HoverLabelHost.css";

/** Draws the window's hover label; mounted once in each window's tree. */
export function HoverLabelHost(): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const airspaceRef = useAirspaceRegistration();
  const labelBoxRef = useRef<HTMLDivElement>(null);
  const { shown, close } = useShownHoverLabel(ownerWindow.document, labelBoxRef);
  return (
    <Tooltip.Root
      open={shown !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <Tooltip.Portal container={ownerWindow.document.body}>
        <Tooltip.Positioner
          ref={labelBoxRef}
          className={overlayClassName(undefined)}
          anchor={shown?.anchor}
          side={shown?.side}
          sideOffset={0}
        >
          <Tooltip.Popup
            ref={airspaceRef}
            className={overlayClassName("meridian-hover-label")}
            aria-hidden="true"
          >
            <span className="meridian-hover-label__box">{shown?.text}</span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
