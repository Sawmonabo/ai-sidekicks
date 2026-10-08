// The one hover label a window draws, for whichever trigger `HoverLabel` marked that the pointer or
// the keyboard is on. Base UI's tooltip places it against that trigger, flips it where its side has
// no room, and closes it on a press anywhere else, Escape being `useShownHoverLabel`'s; which
// trigger it belongs to is read from the document. The label sits flush against its trigger, its
// gap drawn inside its own transparent edge, so the pointer crosses straight from the trigger onto
// it without closing it.

import { useRef } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

import { overlayClassName } from "#renderer/components/OverlayPopups/overlay-class-name.js";
import { useAirspaceRegistration } from "#renderer/hooks/useAirspaceRegistration.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useShownHoverLabel } from "./hooks/useShownHoverLabel.js";

import "./WindowHoverLabel.css";

/** Draws the window's hover label; mounted once in each window's tree. */
export function WindowHoverLabel(): React.JSX.Element {
  const ownerWindow = useOwnerWindow();
  const airspaceRef = useAirspaceRegistration();
  const labelBoxRef = useRef<HTMLDivElement>(null);
  const { shown, close } = useShownHoverLabel(ownerWindow.document, labelBoxRef);
  return (
    <Tooltip.Root
      open={shown !== undefined}
      onOpenChange={(open, details) => {
        // Escape is the label hook's to take; one it passes on stays the page's, uncanceled.
        if (details.reason === "escape-key") {
          details.cancel();
          details.allowPropagation();
        } else if (!open) {
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
            // A press on the label keeps focus where it was: the label is never a place to be.
            onPointerDown={(event) => {
              event.preventDefault();
            }}
          >
            <span className="meridian-hover-label__box">{shown?.text}</span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
